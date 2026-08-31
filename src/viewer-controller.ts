import { createHash, randomUUID } from 'crypto';
import { CsvDataSource } from './data-source/csv-source';
import {
    build_source_from_buffer,
    csv_source_from_buffer,
} from './data-source/from-buffer';
import { ExcelHeaderDataSource } from './data-source/excel-header-source';
import type {
    DataSource,
    RenderedCell,
    SheetMeta,
    WorkbookMeta,
} from './data-source/interface';
import {
    projected_row_for_source,
    read_source_rows_indexed,
    source_row_projection_signature,
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
import { CompareDataSource, align_workbook } from './diff-compare/compare-session';
import { AlignmentCancelledError } from './diff-compare/row-alignment';
import type { UnresolvedLfsObject, WorkbookSnapshotCompare } from './viewer-snapshot';
import type { GitLfsResolveOutcome } from './host-ports';
import { MAX_POINTER_BYTES, parse_git_lfs_pointer } from './git-lfs-pointer';
import { UnresolvedLfsDataSource } from './data-source/unresolved-lfs-source';
import {
    assert_safe_file_size,
    FileSizeLimitExceededError,
    MAX_CSV_ROWS,
    MAX_SHEET_ROWS,
    UNBOUNDED_SHEET_ROWS,
    MAX_WORKBOOK_FORMULAS,
} from './spreadsheet-safety';
import { prepare_csv_serializer, serialize_delimited_values } from './serialize-csv';
import {
    create_xlsx_formula_write_plan,
    capture_xlsx_append_row_format,
    xlsx_append_style_dependency_fingerprint,
    write_xlsx_workbook_cell_edits,
    type XlsxFormulaWritePlan,
} from './xlsx-package';
import {
    all_workbook_formula_cells_impact,
    assert_safe_workbook_formula_edits,
    plan_workbook_formula_recalculation,
} from './formula-dependencies';
import {
    calculate_workbook_formulas_bounded,
    type FormulaCalculationRequest,
    type FormulaCalculationResult,
} from './formula-calculation';
import { is_xlsx_formula_edit, type XlsxCellEdit } from './xlsx-cell-write';
import { pending_formula_cells_referencing_provisional_rows } from './pending-formula-rebase';
import {
    base_validation_save_rejection,
    validate_dirty_bases,
} from './csv-base-validation';
import { cell_edit_base } from './cell-edit-model';
import { get_raw_cell_text } from './cell-display';
import { cell_key, parse_cell_key } from './cell-key';
import type { CellHyperlink, RichText } from './cell-content';
import { committed_column_name, normalized_column_name } from './column-name';
import type { XlsxHyperlinkEdit } from './xlsx-hyperlink-write';
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
import { parse_http_external_url } from './external-url';
import { is_plain_record } from './plain-record';
import {
    acquire_file_coordinator,
    type ExcelHeaderOperationReceipt,
    type FileAuthoritySnapshot,
    type FileRefreshEvent,
    type FileRefreshSubscriberResult,
    type PhysicalAuthorityCommitReceipt,
} from './file-coordinator';
import { reconcile_finalization } from './finalization-reconciliation';
import {
    SourceCandidate,
    type PhysicalSourceObservation,
} from './source-candidate';
import {
    EMPTY_TRANSFORM,
    MAX_PERSISTED_HIDDEN_ROWS,
    MAX_PERSISTED_ROW_HEIGHTS,
    has_any_pending_edits,
    own_wire_pending_changes,
    pending_changes_for_sheet,
    pending_edits_for_sheet,
    reconcile_pending_edit_sheets,
    sanitize_excel_header_overrides,
    sheet_name_from_transform_schema,
    transform_has_entries,
    transform_is_active,
    transform_schema_for_sheet,
    with_pending_changes_for_sheet,
    with_pending_edits_for_sheet,
    worksheet_identity,
    worksheet_target_index,
    worksheet_target_key,
    worksheet_target_lookup,
    worksheet_target_matches,
    type ActiveCsvSaveLifecycle,
    type CellHighlightColor,
    type CsvDirtyMap,
    type CsvDirtyEntry,
    dirty_entries_equal,
    dirty_entry_link_changed,
    dirty_entry_value_changed,
    is_wire_save_correlation,
    sanitized_wire_dirty_entry,
    sanitized_wire_save_maps,
    sanitized_wire_worksheet_target,
    save_lifecycle_correlation,
    type CsvSaveCorrelation,
    type CsvSaveLifecycle,
    type CsvSaveOperation,
    type CsvSaveWorksheetOperation,
    type CsvSaveRejection,
    type HostMessage,
    type PerFileState,
    type SheetPendingEditCells,
    type SheetTransformState,
    type StoredPerFileState,
    type WebviewMessage,
    type WorksheetIdentity,
    type WorksheetIdentityInput,
    type WorksheetPendingEdits,
    type WorksheetPendingChanges,
    type WorksheetTarget,
} from './types';
import {
    normalize_sheet_state_array,
    sanitize_transform_state,
} from './webview/sheet-state';
import { sanitize_column_visibility_state } from './webview/column-projection';
import { create_column_projection } from './webview/column-projection';
import {
    advance_pending_append_basis,
    assert_json_encoded_bound,
    assert_pending_changes_encoded_bound,
    assert_pending_user_changes_encoded_bound,
    EMPTY_PENDING_STRUCTURAL_CHANGES,
    MAX_PENDING_APPENDED_ROWS,
    own_pending_structural_changes,
    type PendingAppendedRow,
    type PendingAppendBasis,
    type PendingRowFormat,
    type PendingRowFormatTemplate,
    type PendingTailRemoval,
    type PendingStructuralChanges,
    type PendingStructuralConflict,
    type PendingStructuralConflictReason,
    type SavedAppendedRowSnapshot,
} from './pending-changes';
import { MAX_HISTORY_ACTION_ENCODED_BYTES } from './history-limits';
import { RetainedPendingAppendAuthorityStore } from './retained-pending-append-authority';
import { AppendAdmissionTemplateAuthorityStore } from './append-admission-template-authority';
// The host is now the only writer of durable heights, so the floor a resize is clamped
// against has to be applied here. Imported from the webview module that already owns it
// rather than restated: two copies of a minimum are two numbers that can drift, and the
// module is pure arithmetic with no DOM or Glide imports — the same reason
// `sanitize_transform_state` and `sanitize_column_visibility_state` above already cross
// this boundary.
import { clamp_row_height } from './webview/row-heights';
import {
    apply_cell_highlight_patch,
    cell_highlight_states_equal,
    rebase_cell_highlight_digest,
    reconcile_physical_cell_highlights,
} from './cell-highlights';
import {
    apply_layout_state_patch,
    derive_layout_state_patch,
} from './layout-state-patch';
import {
    sanitized_abandon_history_replay_request,
    sanitized_commit_history_replay_request,
    replay_request_requires_edit_session,
    sanitized_prepare_history_replay_request,
    type CommitHistoryReplayRequest,
    type HistoryReplayCommitRefused,
    type HistoryReplayCommitted,
    type HistoryReplayAcceptedStructuralWrite,
    type HistoryReplayFocus,
    type HistoryReplayHighlightInput,
    type HistoryReplayPrepareRefused,
    type HistoryReplayPreparedCell,
    type HistoryReplayStructuralInput,
    type PrepareHistoryReplayRequest,
} from './history-replay-protocol';
import { resolve_replay_display_focus } from './history-replay-focus-model';
import { create_history_replay_lease_registry } from './history-replay-lease-model';
import {
    pending_edits_with_replay_writes,
    prepared_content_unchanged,
    replay_cell_key,
    replay_cell_matches,
    replay_highlight_matches,
    replay_highlight_patches,
    type ReplayCellWrite,
} from './history-replay-durable-model';
import {
    complete_normalized_per_file_state,
    normalize_workbook_snapshot_state,
    type NormalizedPerFileState,
    type WorkbookSnapshotIdentity,
} from './viewer-snapshot';

const SAVE_WINDOW = 10_000;

/**
 * What a profile needs to turn one worksheet's edits into bytes.
 *
 * `wanted_bases` names the cells whose pre-edit raw text the save must observe,
 * as `row:col` source keys. CSV harvests them from the serialization walk it
 * already makes, so the two jobs are one interface rather than two traversals
 * of a million-row file.
 */
export interface SavePlanWorksheetInput {
    readonly sheet_index: number;
    /** Source-keyed `row:col` → new text, exactly the cells the user changed. */
    readonly edits: Readonly<Record<string, string>>;
    readonly wanted_bases: ReadonlySet<string>;
    /**
     * The full dirty entries behind `edits`, for planners that write more than
     * the plain-text projection — the xlsx planner reads `valueRuns` from here
     * so a styled edit reaches the package as rich runs. CSV ignores it: its
     * serializer is text-only by design.
     */
    readonly dirty_edits?: CsvDirtyMap;
    readonly structural_changes?: CsvSaveWorksheetOperation['structuralChanges'];
}

export interface SavePlanInput {
    readonly source: DataSource;
    readonly file_path: string;
    readonly worksheets: readonly SavePlanWorksheetInput[];
    readonly cached_formula_calculation?: (
        request: FormulaCalculationRequest,
    ) => readonly FormulaCalculationResult[] | undefined;
}

export interface SavePlan {
    /** Observed pre-edit raw text per worksheet, in input order. A missing key
     *  reads as "" downstream, matching a blank cell. */
    readonly observed_bases: readonly ReadonlyMap<string, string>[];
    /**
     * The same cells' effective rich content per worksheet, present only for
     * planners whose source carries formatting (xlsx). Absent for CSV, whose
     * validation contract stays text-only. Base validation reads this so a
     * formatting-only external change conflicts a stale edit like a text
     * change does.
     */
    readonly observed_rich?: readonly ReadonlyMap<string, RichText>[];
    /**
     * The cells' hyperlinks per worksheet, xlsx only. Every observed cell has
     * an entry (`null` = linkless), so validation can distinguish "the cell
     * verifiably has no link" from "the cell was never observed".
     */
    readonly observed_links?: readonly ReadonlyMap<string, CellHyperlink | null>[];
    /** Canonical identity transition committed by the bytes this plan produces. */
    readonly receipt?: import('./types').PendingChangesSaveReceipt;
    /**
     * The bytes to write, given the file's current bytes.
     *
     * `raw` is what the caller just read and verified against the acknowledged
     * digest. CSV ignores it — it re-serializes the whole file from the source.
     * xlsx splices into it, which is what makes the save `putexcel`-shaped:
     * every part it does not touch is copied through byte-for-byte.
     */
    produce(raw: Uint8Array): Uint8Array;
}

/** Expected structural refusal, kept distinct from writer/programming failures. */
class PendingStructuralSaveError extends Error {
    constructor(
        readonly worksheetOperationIndex: number,
        readonly conflict: PendingStructuralConflict,
        message: string,
    ) {
        super(message);
        this.name = 'PendingStructuralSaveError';
    }
}

function structural_save_error(
    worksheet_operation_index: number,
    structural: PendingStructuralChanges,
    reason: PendingStructuralConflictReason,
    message: string,
    affected?: {
        readonly pendingRowIds?: readonly string[];
        readonly tailRemovalIds?: readonly string[];
        readonly formulaCells?: PendingStructuralConflict['formulaCells'];
    },
): never {
    throw new PendingStructuralSaveError(
        worksheet_operation_index,
        Object.freeze({
            reason,
            pendingRowIds: Object.freeze([...(affected?.pendingRowIds
                ?? structural.appendedRows.map((row) => row.id))]),
            tailRemovalIds: Object.freeze([...(affected?.tailRemovalIds
                ?? structural.tailRemovals.map((removal) => removal.appendHistoryId))]),
            ...(affected?.formulaCells === undefined ? {} : {
                formulaCells: Object.freeze([...affected.formulaCells]),
            }),
        }),
        message,
    );
}

function structural_save_rejection(error: unknown): CsvSaveRejection | undefined {
    if (!(error instanceof PendingStructuralSaveError)) return undefined;
    return Object.freeze({
        reason: 'structuralConflict',
        worksheetOperationIndex: error.worksheetOperationIndex,
        structuralReason: error.conflict.reason,
        pendingRowIds: error.conflict.pendingRowIds,
        tailRemovalIds: error.conflict.tailRemovalIds,
        ...(error.conflict.formulaCells === undefined ? {} : {
            formulaCells: error.conflict.formulaCells,
        }),
    });
}

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
    /** Close the exact host surface when its initial source load is declined. */
    readonly requestClose?: () => void | Promise<void>;
    /** Git compare mode: render the file read-only with per-cell diffs against
     *  this original (the `git:` side of an SCM diff). A failure to read or
     *  parse the original degrades to a normal read-only open, never a block. */
    readonly compare?: { readonly originalUri: ResourceUriLike | string };
    /** Render read-only regardless of the profile (e.g. a git: revision URI,
     *  which has no working-tree file to write back to). */
    readonly readOnly?: boolean;
    /** Test-host protocol seam. It is supplied only by the VS Code integration
     * runner and observes the real controller transport without replacing it. */
    readonly integrationTestPort?: {
        on_host_message(message: HostMessage): void;
        on_webview_message(message: WebviewMessage): void;
        register_webview_message_receiver(
            receiver: (message: WebviewMessage) => Promise<void>,
        ): void;
        /** Observe the exact work set captured by a controller drain iteration. */
        on_controller_drain_wait?(work: readonly string[]): void;
    };
}

export interface ViewerController extends Disposable {
    /** Select a worksheet by its workbook name once the renderer has a snapshot. */
    select_sheet(sheet_name: string): Promise<boolean>;
    /** Re-read a retained panel only when either comparison side has changed. */
    refresh_if_changed(): Promise<boolean>;
    /** Refuse every new edit session before a shutdown/activation barrier begins. */
    stop_edit_admission(): void;
    /** Fence the current renderer and wait for its exact durable edit acknowledgement. */
    flush_pending_edits(): Promise<void>;
    /** Wait for all controller work admitted before the call to settle. */
    drain(): Promise<void>;
}

export interface ViewerSourceBuildOptions {
    readonly loadAllRows?: boolean;
    /** Observable cancellation for long-running file-backed opens. */
    readonly isCancelled?: () => boolean;
}

interface FileSourceBuildResult {
    readonly source: DataSource;
    readonly digest: string;
    readonly size: number;
    readonly mtime: number;
}

interface ViewerProfileBase {
    /** Build a DataSource from freshly-read bytes. Throws are surfaced as errors. */
    build_source(
        raw: Uint8Array,
        file_path: string,
        state: PerFileState,
        options?: ViewerSourceBuildOptions,
    ): Promise<DataSource>;
    /** Node-local random-access source used when one whole-file Uint8Array is
     * impossible or needlessly expensive. Only file: resources may select it. */
    build_file_source?(
        file_path: string,
        state: PerFileState,
        options?: ViewerSourceBuildOptions,
    ): Promise<FileSourceBuildResult>;
    /** Prefer the file-backed reader even when a whole-file read is possible. */
    prefer_file_source?: boolean;
    /** How many worksheet body rows this format may hold after an append.
     *  Absent means the workbook ceiling (`MAX_SHEET_ROWS`), which is the
     *  limit `assert_safe_sheet_shape` already enforces at open time; delimited
     *  profiles set `UNBOUNDED_SHEET_ROWS` because no such gate applies to
     *  them. Read it through `append_row_ceiling_for`, never directly. */
    readonly append_row_ceiling?: number;
    /** Sets previewMode on the meta envelope (read-only synced preview). */
    previewMode?: boolean;
    /** Called after each (re)load adopts a source — preview refreshes its line map. */
    on_source_adopted?(source: DataSource): void;
    /** Handle a message the controller does not own (preview: visibleRowChanged).
     *  Return true if handled. */
    on_message?(msg: WebviewMessage): boolean | Promise<boolean>;
}

/**
 * A viewer profile, discriminated on whether it can edit.
 *
 * `editing` gates csvEditingSupported and the saveCsv/pendingEdits/showSaveDialog
 * handling; `plan_save` is what a save actually calls. They live on the same arm
 * of the union so a profile cannot claim the first without supplying the second —
 * the alternative is a runtime "this file type cannot be saved" error thrown from
 * inside a save the user has already confirmed.
 */
export type ViewerProfile = ViewerProfileBase & (
    | { readonly editing: false; readonly plan_save?: undefined }
    | {
        readonly editing: true;
        /** Harvest conflict bases now; produce the bytes to write at write time. */
        plan_save(input: SavePlanInput): SavePlan;
        /** How cell text is edited (WorkbookSnapshotCapabilities.editSyntax).
         *  'markdown' for xlsx, whose planner writes styled runs; absent = plain. */
        readonly edit_syntax?: 'markdown';
    }
);

/**
 * What an edit-session cleanup is clearing.
 *
 * A successful save clears the one worksheet it wrote — the session is
 * workbook-scoped but a save is not, and the sibling sheets' unsaved drafts must
 * survive it. A discard ends the whole session, so it clears every live sheet's
 * slot at once.
 *
 * The sheet scope carries a name beside the index for the same reason a save
 * tombstone does: the index is a position captured when the cleanup began,
 * durable slots are reconciled by name on every write, and an `uncertain`
 * cleanup can be retried arbitrarily later — after an external reorder has moved
 * the slot. Clearing by the stale position would delete another worksheet's
 * unsaved draft and leave this one's edits behind.
 */
type EditCleanupScope =
    | { type: 'workbook' }
    | { type: 'worksheets'; targets: readonly WorksheetTarget[] };

type CsvEditFilePhase =
    | { type: 'free' }
    | { type: 'claiming'; claim: symbol; token: symbol }
    | { type: 'owned'; token: symbol }
    | { type: 'releasing'; release: symbol; token: symbol }
    // `scope` is what the clear is removing: a recovery that runs long after the
    // session ended has no other way left to learn what the cleanup was for.
    | { type: 'cleanupPending'; operation: symbol; scope: EditCleanupScope }
    | { type: 'uncertain'; operation: symbol; scope: EditCleanupScope };

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
// Node/Electron's whole-file read rejects at this boundary even on 64-bit
// systems. Local DTA files beyond it use the parser's descriptor-backed path.
const MAX_WHOLE_FILE_READ_BYTES = 2 * 1024 * 1024 * 1024 - 1;
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
const COMPARE_DIFF_INCOMPLETE_WARNING =
    'Table Viewer could not compare some visible cells. Unhighlighted cells may still differ.';
const MAX_SAVED_APPEND_AUTHORITIES = 100_000;
const MAX_SAVED_APPEND_AUTHORITY_BYTES = 256 * 1024 * 1024;
const MAX_ACTIONABLE_STRUCTURAL_CONFLICT_ROW_IDS = 16;

function content_digest(bytes: Uint8Array): string {
    return createHash('sha256').update(bytes).digest('hex');
}

function worksheet_append_schema_fingerprint(sheet: SheetMeta): string {
    return `sha256:${createHash('sha256').update(JSON.stringify({
        columnCount: sheet.columnCount,
        columnNames: sheet.columnNames ?? null,
    })).digest('hex')}`;
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

function is_abort_error(error: unknown): boolean {
    return error instanceof Error && error.name === 'AbortError';
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
    /** Admission belongs to this logical load, including its stability retries. */
    bypassFileSizeLimit?: boolean;
}

interface CsvSaveHostOperation {
    /** Exact normalized operation used for host lifecycle ownership. */
    readonly identity: CsvSaveOperation;
    /** Host-resolved worksheet targets, in the operation's deterministic order. */
    readonly durableTargets: readonly WorksheetTarget[];
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

function group_cell_keys_by_source_row(
    keys: Iterable<string>,
): Map<number, number[]> {
    const columns_by_source_row = new Map<number, number[]>();
    for (const key of keys) {
        const coordinates = parse_cell_key(key);
        if (!coordinates) continue;
        const { sourceRow: source_row, sourceColumn: column } = coordinates;
        const columns = columns_by_source_row.get(source_row);
        if (columns) columns.push(column);
        else columns_by_source_row.set(source_row, [column]);
    }
    return columns_by_source_row;
}

/**
 * Read the current value of each wanted `row:col`, keyed by *source* row.
 *
 * The projection step is the whole of it. Edits are source-keyed, but a
 * `DataSource` reads in projected space, and with a promoted header those spaces
 * differ by one — so reading a source index directly returns the neighbouring
 * physical row, and every base looks changed. Shared by the save path and the
 * restore path because the two must agree: a base one accepts and the other
 * rejects is a save that refuses work the user was just shown as clean.
 *
 * A row the projection hides is left unobserved, so validation sees `undefined`
 * and rejects rather than writing against a base nobody checked.
 */
function harvest_source_bases(
    src: DataSource,
    sheet_index: number,
    wanted_bases: Iterable<string>,
): {
    texts: Map<string, string>;
    rich: Map<string, RichText>;
    links: Map<string, CellHyperlink | null>;
} {
    const observed_bases = new Map<string, string>();
    // The same cells' *effective* rich content (runs, or the cell font as one
    // run), present only where it carries styles — the exact derivation the
    // webview used to record `baseRuns`, so text-equal bases whose formatting
    // drifted read as conflicts rather than being silently overwritten.
    const observed_rich = new Map<string, RichText>();
    // The cells' hyperlinks. Unlike `rich`, absence must be observable — a
    // link edit's base may legitimately be "no link" — so every observed cell
    // records an entry, `null` for linkless, and only an unobserved cell reads
    // as undefined.
    const observed_links = new Map<string, CellHyperlink | null>();
    // Group by SOURCE row first, so each distinct row is projected once. A wide
    // edit or replay names many columns of one row, and projecting per key would
    // re-walk the source's row mapping once per column for no new information.
    const cols_by_source_row = group_cell_keys_by_source_row(wanted_bases);
    const by_projected_row = new Map<number, { source_row: number; cols: number[] }>();
    const canonical_only = new Map<number, number[]>();
    for (const [source_row, cols] of cols_by_source_row) {
        const projected = projected_row_for_source(src, sheet_index, source_row);
        if (projected === undefined) {
            canonical_only.set(source_row, cols);
            continue;
        }
        const entry = by_projected_row.get(projected);
        // Two source rows projecting to one row is not expected, but merging
        // rather than overwriting keeps every requested column observable.
        if (entry) entry.cols.push(...cols);
        else by_projected_row.set(projected, { source_row, cols });
    }
    const record_row = (
        source_row: number,
        cols: readonly number[],
        row: readonly (RenderedCell | null | undefined)[],
    ): void => {
        for (const col of cols) {
            const cell = row[col];
            if (cell === undefined) continue;
            const cell_key = `${source_row}:${col}`;
            observed_bases.set(cell_key, cell === null ? '' : cell_edit_base(cell).text);
            if (cell !== null) {
                const rich = cell_edit_base(cell).rich;
                if (rich) observed_rich.set(cell_key, rich);
            }
            observed_links.set(cell_key, cell?.hyperlink ?? null);
        }
    };
    const projected_rows = [...by_projected_row.keys()].sort((a, b) => a - b);
    for (let start = 0; start < projected_rows.length; start += SAVE_WINDOW) {
        const batch = projected_rows.slice(start, start + SAVE_WINDOW);
        const { rows } = read_source_rows_indexed(src, sheet_index, batch);
        batch.forEach((projected, offset) => {
            const entry = by_projected_row.get(projected)!;
            const row = rows[offset] ?? [];
            record_row(entry.source_row, entry.cols, row);
        });
    }
    if (src.read_canonical_columns) {
        for (const [source_row, cols] of canonical_only) {
            const unique_cols = [...new Set(cols)].sort((left, right) => left - right);
            const row = src.read_canonical_columns(
                sheet_index, source_row, 1, unique_cols,
            ).rows[0] ?? [];
            const expanded: (RenderedCell | null | undefined)[] = [];
            unique_cols.forEach((column, index) => { expanded[column] = row[index]; });
            record_row(source_row, unique_cols, expanded);
        }
    }
    return { texts: observed_bases, rich: observed_rich, links: observed_links };
}

/**
 * One replay cell's content as read from a verified source.
 *
 * `undefined` for a cell the source cannot answer for — a source row outside the
 * worksheet, or one no longer in the projection. Distinguished from an empty
 * cell, because substituting `''` for an unanswerable cell would fabricate the
 * missing side of an undo transition: undo would write emptiness over content it
 * never saw.
 */
export interface MaterializedReplayCell {
    readonly text: string;
    readonly rich?: RichText;
    readonly hyperlink: CellHyperlink | null;
}

/**
 * Read the persisted content behind a set of replay cells.
 *
 * `harvest_source_bases` per sheet, deliberately: the projection step, the row
 * grouping, the `SAVE_WINDOW` batching and the rich/hyperlink derivation are
 * exactly what a save's base validation needs, and a replay that read cells even
 * slightly differently would refuse bases the save path accepts, or accept ones
 * it refuses. One reader means the two cannot disagree.
 *
 * Renderer page residency has nothing to do with this. The host reads the source
 * directly, so a replay reaches a background sheet and rows the webview never
 * loaded — which is what makes a workbook-wide history possible at all.
 */
function materialize_replay_cells(
    src: DataSource,
    requested: readonly { readonly sheet_index: number; readonly source_row: number; readonly source_column: number }[],
): Map<string, MaterializedReplayCell> {
    const wanted_by_sheet = new Map<number, Set<string>>();
    for (const cell of requested) {
        const wanted = wanted_by_sheet.get(cell.sheet_index);
        const key = `${cell.source_row}:${cell.source_column}`;
        if (wanted === undefined) wanted_by_sheet.set(cell.sheet_index, new Set([key]));
        else wanted.add(key);
    }
    const observed = new Map<string, MaterializedReplayCell>();
    for (const [sheet_index, wanted] of wanted_by_sheet) {
        const { texts, rich, links } = harvest_source_bases(src, sheet_index, wanted);
        for (const key of wanted) {
            // `links` records every OBSERVED cell, `null` included, so its
            // membership — not the text's emptiness — is what separates a blank
            // cell from one the projection never showed us.
            if (!links.has(key)) continue;
            const rich_runs = rich.get(key);
            observed.set(`${sheet_index}:${key}`, {
                text: texts.get(key) ?? '',
                ...(rich_runs ? { rich: rich_runs } : {}),
                hyperlink: links.get(key) ?? null,
            });
        }
    }
    return observed;
}

function canonical_saved_row_physical_cells(
    cells: Readonly<Record<string, import('./pending-changes').PendingRowCell>>,
): readonly unknown[] {
    return Object.entries(cells)
        .map(([column, cell]) => [Number(column), cell] as const)
        .filter(([, cell]) => cell.value !== '' || cell.valueRuns !== undefined || cell.link != null)
        .sort(([left], [right]) => left - right)
        .map(([column, cell]) => [column, {
            value: cell.value,
            ...(cell.valueRuns === undefined ? {} : { valueRuns: cell.valueRuns }),
            ...(cell.link == null ? {} : { link: cell.link }),
        }]);
}

function canonical_saved_row_format(
    format: import('./pending-changes').PendingRowFormat,
    include_viewer_height = true,
): unknown {
    if (format.kind === 'none') return format;
    return {
        kind: format.kind,
        templateSourceRow: format.templateSourceRow,
        styleFingerprint: format.styleFingerprint,
        cellStyleIndexes: format.cellStyleIndexes,
        ...(format.cellStyleFingerprints === undefined ? {} : {
            cellStyleFingerprints: format.cellStyleFingerprints,
        }),
        ...(format.cellNumberFormats === undefined ? {} : {
            cellNumberFormats: format.cellNumberFormats,
        }),
        ...(format.cellFontStyles === undefined ? {} : {
            cellFontStyles: format.cellFontStyles,
        }),
        ...(format.rowStyleIndex === undefined ? {} : {
            rowStyleIndex: format.rowStyleIndex,
        }),
        ...(format.rowNumberFormat === undefined ? {} : {
            rowNumberFormat: format.rowNumberFormat,
        }),
        ...(format.rowFontStyle === undefined ? {} : {
            rowFontStyle: format.rowFontStyle,
        }),
        ...(format.thickTop === undefined ? {} : { thickTop: true }),
        ...(format.thickBottom === undefined ? {} : { thickBottom: true }),
        ...(format.phonetic === undefined ? {} : { phonetic: true }),
        ...(format.nativeRowHeight === undefined ? {} : {
            nativeRowHeight: format.nativeRowHeight,
        }),
        ...(!include_viewer_height || format.viewerRowHeight === undefined ? {} : {
            viewerRowHeight: format.viewerRowHeight,
        }),
    };
}

function saved_row_physical_fingerprint(
    row: Pick<import('./pending-changes').SavedAppendedRowSnapshot, 'cells' | 'format'>,
): string {
    return content_digest(new TextEncoder().encode(JSON.stringify({
        cells: canonical_saved_row_physical_cells(row.cells),
        format: canonical_saved_row_format(row.format, false),
    })));
}

function saved_row_snapshot_fingerprint(
    row: import('./pending-changes').SavedAppendedRowSnapshot,
): string {
    const cells = Object.entries(row.cells)
        .map(([column, cell]) => [Number(column), cell] as const)
        .sort(([left], [right]) => left - right);
    const highlights = Object.entries(row.highlights ?? {})
        .map(([column, color]) => [Number(column), color] as const)
        .sort(([left], [right]) => left - right);
    return content_digest(new TextEncoder().encode(JSON.stringify({
        cells,
        format: canonical_saved_row_format(row.format),
        ...(row.viewerRowHeight === undefined ? {} : {
            viewerRowHeight: row.viewerRowHeight,
        }),
        ...(highlights.length === 0 ? {} : { highlights }),
    })));
}

function saved_pending_row_fingerprint(
    row: import('./pending-changes').PendingAppendedRow,
    format: import('./pending-changes').PendingRowFormat,
): string {
    return saved_row_snapshot_fingerprint({
        cells: row.cells,
        format,
        ...(row.viewerRowHeight === undefined ? {} : {
            viewerRowHeight: row.viewerRowHeight,
        }),
        ...(row.highlights === undefined ? {} : { highlights: row.highlights }),
    });
}

function persisted_saved_row_snapshot(
    row: Pick<
        import('./pending-changes').PendingAppendedRow,
        'cells' | 'viewerRowHeight' | 'highlights'
    >,
    format: import('./pending-changes').PendingRowFormat,
    physical_cells: Readonly<Record<string, import('./pending-changes').PendingRowCell>>,
): import('./pending-changes').SavedAppendedRowSnapshot {
    const cells: Record<string, import('./pending-changes').PendingRowCell> = {};
    const columns = new Set([
        ...Object.keys(row.cells),
        ...Object.keys(physical_cells),
    ]);
    for (const column of columns) {
        const physical = physical_cells[column] ?? { value: '' };
        const metadata = row.cells[column];
        cells[column] = Object.freeze({
            value: physical.value,
            ...(physical.valueRuns === undefined ? {} : { valueRuns: physical.valueRuns }),
            ...(physical.link === undefined ? {} : { link: physical.link }),
            ...(metadata?.valueEditOrder === undefined ? {} : {
                valueEditOrder: metadata.valueEditOrder,
            }),
            ...(metadata?.formulaReferenceBases === undefined ? {} : {
                formulaReferenceBases: metadata.formulaReferenceBases,
            }),
            ...(metadata?.movedFrom === undefined ? {} : { movedFrom: metadata.movedFrom }),
        });
    }
    const viewer_row_height = row.viewerRowHeight
        ?? (format.kind === 'xlsx' ? format.viewerRowHeight : undefined);
    return Object.freeze({
        cells: Object.freeze(cells),
        format,
        ...(viewer_row_height === undefined ? {} : {
            viewerRowHeight: viewer_row_height,
        }),
        ...(row.highlights === undefined ? {} : { highlights: row.highlights }),
    });
}

function source_row_cells_for_fingerprint(
    src: DataSource,
    sheet_index: number,
    source_row: number,
): Readonly<Record<string, import('./pending-changes').PendingRowCell>> {
    const projected_row = projected_row_for_source(src, sheet_index, source_row);
    const row = projected_row === undefined
        ? (() => {
            const column_count = src.meta().sheets[sheet_index]?.columnCount ?? 0;
            if (!src.read_canonical_columns || column_count === 0) return undefined;
            return src.read_canonical_columns(
                sheet_index,
                source_row,
                1,
                Array.from({ length: column_count }, (_, column) => column),
            ).rows[0];
        })()
        : (() => {
            const window = src.read_rows(sheet_index, projected_row, 1);
            return window.startRow === projected_row && window.rows.length === 1
                ? window.rows[0]
                : undefined;
        })();
    if (row === undefined) {
        throw new Error('A saved appended row is no longer available.');
    }
    const cells: Record<string, import('./pending-changes').PendingRowCell> = {};
    for (const [column, cell] of row.entries()) {
        if (cell === null) continue;
        const value = cell.formula ?? get_raw_cell_text(cell.raw);
        if (value === '' && cell.richText === undefined && cell.hyperlink == null) continue;
        cells[column] = {
            value,
            ...(cell.richText === undefined ? {} : { valueRuns: cell.richText }),
            ...(cell.hyperlink == null ? {} : { link: cell.hyperlink }),
        };
    }
    return cells;
}

/**
 * `putexcel`-shaped save: rewrite exactly the edited cells, leave the rest of
 * the package alone.
 *
 * Edit keys are canonical *source* rows of the worksheet, which for xlsx are its
 * physical rows — the same space `xl/worksheets/sheetN.xml` numbers, offset by
 * one. A promoted header row shifts only the *projected* space the grid shows,
 * so it never reaches these keys; it does have to be undone to read a base back
 * out, which is what `projected_row_for_source` is for.
 */
function plan_xlsx_save(input: SavePlanInput): SavePlan {
    const { source: src } = input;
    // Every worksheet is fully planned before bytes are produced. The package
    // writer likewise computes every replacement before mutating the container,
    // so one invalid worksheet rejects the workbook save atomically.
    const planned = input.worksheets.map(({
        sheet_index,
        edits,
        wanted_bases,
        dirty_edits,
        structural_changes,
    }, worksheet_operation_index) => {
        const {
            texts: observed_bases,
            rich: observed_rich,
            links: observed_links,
        } = harvest_source_bases(src, sheet_index, wanted_bases);
        const cell_edits: XlsxCellEdit[] = [];
        const sheet_meta = src.meta().sheets[sheet_index];
        if (!sheet_meta) throw new Error('Could not locate a worksheet to save.');
        const structural = structural_changes ?? own_pending_structural_changes({});
        if (structural.conflicts.length > 0) {
            throw new PendingStructuralSaveError(
                worksheet_operation_index,
                structural.conflicts[0],
                'Pending rows have unresolved structural conflicts.',
            );
        }
        if (
            structural.appendedRows.length > 0
            && structural.appendBasis === undefined
        ) structural_save_error(
            worksheet_operation_index,
            structural,
            'ambiguousColumns',
            'Pending rows have no verified worksheet basis.',
        );
        if (
            structural.appendBasis !== undefined
            && (structural.appendBasis.columnCount !== sheet_meta.columnCount
                || structural.appendBasis.schemaFingerprint
                    !== worksheet_append_schema_fingerprint(sheet_meta))
        ) structural_save_error(
            worksheet_operation_index,
            structural,
            'ambiguousColumns',
            'The worksheet columns changed after rows were appended.',
        );
        const retained_row_count = sheet_meta.sourceRowCount
            - structural.tailRemovals.length;
        if (retained_row_count < 0
            || retained_row_count + structural.appendedRows.length > MAX_SHEET_ROWS) {
            structural_save_error(
                worksheet_operation_index,
                structural,
                'rowLimitExceeded',
                'Pending row changes exceed the worksheet row limit.',
            );
        }
        structural.tailRemovals.forEach((removal, index) => {
            if (removal.sourceRow !== retained_row_count + index) {
                structural_save_error(
                    worksheet_operation_index,
                    structural,
                    'savedSuffixChanged',
                    'Pending row removals are not a contiguous worksheet suffix.',
                    { pendingRowIds: [], tailRemovalIds: [removal.appendHistoryId] },
                );
            }
        });
        const pending_index_by_id = new Map(structural.appendedRows.map(
            (row, index) => [row.id, index],
        ));
        const physical_row_for_identity = (identity: import('./pending-changes').RowIdentity):
            number | undefined => identity.kind === 'source'
            ? identity.sourceRow
            : (() => {
                const index = pending_index_by_id.get(identity.pendingRowId);
                return index === undefined ? undefined : retained_row_count + index;
            })();
        const resolved_move = (
            moved: NonNullable<CsvDirtyEntry['movedFrom']> | undefined,
            affected_cell: NonNullable<PendingStructuralConflict['formulaCells']>[number],
        ): XlsxCellEdit['movedFrom'] | undefined => {
            if (moved === undefined) return undefined;
            const row = moved.rowIdentity === undefined
                ? moved.row
                : physical_row_for_identity(moved.rowIdentity);
            if (row === undefined) {
                structural_save_error(
                    worksheet_operation_index,
                    structural,
                    'ambiguousPendingFormula',
                    'A cut source row no longer has a stable destination.',
                    {
                        pendingRowIds: affected_cell.rowIdentity.kind === 'pending'
                            ? [affected_cell.rowIdentity.pendingRowId]
                            : [],
                        tailRemovalIds: [],
                        formulaCells: [affected_cell],
                    },
                );
            }
            const previous = moved.previous?.map((step) => {
                const sourceRow = step.sourceRowIdentity === undefined
                    ? step.sourceRow
                    : physical_row_for_identity(step.sourceRowIdentity);
                const destinationRow = step.destinationRowIdentity === undefined
                    ? step.destinationRow
                    : physical_row_for_identity(step.destinationRowIdentity);
                if (sourceRow === undefined || destinationRow === undefined) {
                    structural_save_error(
                        worksheet_operation_index,
                        structural,
                        'ambiguousPendingFormula',
                        'A prior cut row no longer has a stable destination.',
                        {
                            pendingRowIds: affected_cell.rowIdentity.kind === 'pending'
                                ? [affected_cell.rowIdentity.pendingRowId]
                                : [],
                            tailRemovalIds: [],
                            formulaCells: [affected_cell],
                        },
                    );
                }
                return {
                    sourceRow,
                    sourceCol: step.sourceCol,
                    destinationRow,
                    destinationCol: step.destinationCol,
                    order: step.order,
                };
            });
            return {
                row,
                col: moved.col,
                order: moved.order,
                ...(previous === undefined ? {} : { previous }),
            };
        };
        const templates = new Map(structural.formatTemplates.map(
            (template) => [template.id, template.format],
        ));
        const header_row = sheet_meta?.excelFirstRowHeader?.sourceRow ?? 0;
        for (const [key, value] of Object.entries(edits)) {
            const [row, col] = key.split(':').map(Number);
            if (!Number.isInteger(row) || !Number.isInteger(col)) continue;
            if (
                structural.tailRemovals.length > 0
                && row >= retained_row_count
                && row < sheet_meta.sourceRowCount
            ) {
                throw new Error('A removed tail row also contains a source-cell edit.');
            }
            // A styled edit carries its runs through to the package writer.
            // `validate_edit_cells` already required the runs' concatenated text
            // to equal `value`, so the plain projection and the rich form cannot
            // disagree by the time they get here.
            const runs = dirty_edits?.[key]?.valueRuns?.runs;
            const moved_from = resolved_move(dirty_edits?.[key]?.movedFrom, {
                rowIdentity: { kind: 'source', sourceRow: row },
                sourceColumn: col,
            });
            const value_edit_order = dirty_edits?.[key]?.valueEditOrder;
            const header_edit = sheet_meta?.excelFirstRowHeader?.active === true
                && row === header_row;
            cell_edits.push({
                row,
                col,
                value: header_edit ? committed_column_name(value) : value,
                ...(header_edit ? { force_text: true } : {}),
                ...(!header_edit && runs && runs.length > 0 ? { runs } : {}),
                ...(moved_from === undefined ? {} : { movedFrom: moved_from }),
                ...(value_edit_order === undefined ? {} : { valueEditOrder: value_edit_order }),
            });
        }
        // Link edits come from the exact dirty entries, not `edits`: a
        // link-only change carries no text edit at all (see
        // collect_save_payload), and a text edit may carry no link change.
        const link_edits: XlsxHyperlinkEdit[] = [];
        for (const [key, entry] of Object.entries(dirty_edits ?? {})) {
            if (!dirty_entry_link_changed(entry)) continue;
            const [row, col] = key.split(':').map(Number);
            if (!Number.isInteger(row) || !Number.isInteger(col)) continue;
            // The host is the authority on what an external target may be —
            // the dialog validates for UX, but the wire is untrusted. Only the
            // WRITTEN value is constrained to http(s); bases mirror whatever
            // the file already holds. Fail the save closed rather than write a
            // scheme the dialog could never have produced.
            if (entry.link?.kind === 'external') {
                const normalized = parse_http_external_url(entry.link.target);
                if (normalized === null) {
                    throw new Error('A hyperlink edit has an invalid or non-HTTP target.');
                }
                link_edits.push({
                    row,
                    col,
                    link: { ...entry.link, target: normalized },
                });
                continue;
            }
            link_edits.push({ row, col, link: entry.link ?? null });
        }
        // A worksheet hyperlink is owned outside its row element. Clear links
        // captured in removed-row snapshots or they can recreate deleted cells.
        for (const removal of structural.tailRemovals) {
            for (const [column, cell] of Object.entries(removal.savedRow.cells)) {
                if (cell.link !== undefined) {
                    link_edits.push({ row: removal.sourceRow, col: Number(column), link: null });
                }
            }
        }
        const append_shells: Array<NonNullable<
            import('./xlsx-package').XlsxWorksheetCellEdits['row_changes']
        >['appendRows'][number]> = [];
        for (const [index, row] of structural.appendedRows.entries()) {
            const format = templates.get(row.formatTemplateId);
            if (!format || format.kind !== 'xlsx') {
                structural_save_error(
                    worksheet_operation_index,
                    structural,
                    'templateChanged',
                    'An XLSX pending row has no XLSX format template.',
                    { pendingRowIds: [row.id], tailRemovalIds: [] },
                );
            }
            if (format.cellStyleIndexes.length !== sheet_meta.columnCount) {
                structural_save_error(
                    worksheet_operation_index,
                    structural,
                    'templateChanged',
                    'An XLSX pending row format has the wrong width.',
                    { pendingRowIds: [row.id], tailRemovalIds: [] },
                );
            }
            const destination = retained_row_count + index;
            append_shells.push(Object.freeze({
                row: destination,
                cellStyleIndexes: format.cellStyleIndexes,
                ...(format.rowStyleIndex === undefined
                    ? {}
                    : { rowStyleIndex: format.rowStyleIndex }),
                ...(format.thickTop === undefined ? {} : { thickTop: true as const }),
                ...(format.thickBottom === undefined ? {} : { thickBottom: true as const }),
                ...(format.phonetic === undefined ? {} : { phonetic: true as const }),
                ...(format.nativeRowHeight === undefined
                    ? {}
                    : { height: format.nativeRowHeight }),
            }));
            for (const [column_text, pending_cell] of Object.entries(row.cells)) {
                const column = Number(column_text);
                if (column >= sheet_meta.columnCount) {
                    throw new Error('A pending row contains a column outside the worksheet.');
                }
                const moved_from = resolved_move(pending_cell.movedFrom, {
                    rowIdentity: { kind: 'pending', pendingRowId: row.id },
                    sourceColumn: column,
                });
                cell_edits.push({
                    row: destination,
                    col: column,
                    value: pending_cell.value,
                    ...(pending_cell.valueRuns?.runs.length
                        ? { runs: pending_cell.valueRuns.runs }
                        : {}),
                    ...(pending_cell.valueEditOrder === undefined
                        ? {}
                        : { valueEditOrder: pending_cell.valueEditOrder }),
                    ...(moved_from === undefined ? {} : { movedFrom: moved_from }),
                });
                if (pending_cell.link !== undefined) {
                    if (pending_cell.link?.kind === 'external') {
                        const normalized = parse_http_external_url(pending_cell.link.target);
                        if (normalized === null) {
                            throw new Error('A pending-row hyperlink has an invalid target.');
                        }
                        link_edits.push({
                            row: destination,
                            col: column,
                            link: { ...pending_cell.link, target: normalized },
                        });
                    } else {
                        link_edits.push({
                            row: destination,
                            col: column,
                            link: pending_cell.link,
                        });
                    }
                }
            }
        }
        const row_changes = structural.tailRemovals.length > 0
            || append_shells.length > 0
            ? Object.freeze({
                sourceRowCount: sheet_meta.sourceRowCount,
                removeRows: Object.freeze(structural.tailRemovals.map(
                    (removal) => removal.sourceRow,
                )),
                appendRows: Object.freeze(append_shells),
            })
            : undefined;
        return {
            worksheetOperationIndex: worksheet_operation_index,
            observed_bases,
            observed_rich,
            observed_links,
            sheetIndex: sheet_index,
            edits: cell_edits,
            link_edits,
            ...(row_changes === undefined ? {} : { row_changes }),
            structural,
            retainedRowCount: retained_row_count,
            formulaSourceCells: dirty_edits ?? {},
        };
    });
    for (const formula_worksheet of planned) {
        for (const target_worksheet of planned) {
            const formulaCells = pending_formula_cells_referencing_provisional_rows(
                formula_worksheet.structural,
                formula_worksheet.formulaSourceCells,
                target_worksheet.structural,
                formula_worksheet.sheetIndex,
                target_worksheet.sheetIndex,
                src.meta().sheets,
            );
            if (formulaCells.length > 0) {
                structural_save_error(
                    formula_worksheet.worksheetOperationIndex,
                    formula_worksheet.structural,
                    'ambiguousPendingFormula',
                    'A pending formula references a provisional row coordinate that changed.',
                    {
                        pendingRowIds: [...new Set(formulaCells.flatMap((cell) =>
                            cell.rowIdentity.kind === 'pending'
                                ? [cell.rowIdentity.pendingRowId]
                                : []))],
                        tailRemovalIds: [],
                        formulaCells,
                    },
                );
            }
        }
    }
    const calculation_edits: Array<{
        sheetIndex: number;
        row: number;
        column: number;
        value: string;
        writesFormula: boolean;
        runs?: XlsxCellEdit['runs'];
    }> = [];
    for (const worksheet of planned) {
        const sheet = src.meta().sheets[worksheet.sheetIndex];
        if (sheet?.excelFirstRowHeader?.active !== true || !sheet.columnNames) continue;
        const header_row = sheet.excelFirstRowHeader.sourceRow ?? 0;
        const final_names = [...sheet.columnNames];
        const changed_columns = new Set<number>();
        for (const edit of worksheet.edits) {
            if (edit.row !== header_row || final_names[edit.col] === undefined) continue;
            const old_name = final_names[edit.col];
            const new_name = committed_column_name(edit.value);
            if (new_name === '' && old_name !== '') {
                throw new Error('A column name cannot be blank.');
            }
            final_names[edit.col] = new_name;
            if (new_name !== old_name) changed_columns.add(edit.col);
        }
        for (const column of changed_columns) {
            const normalized = normalized_column_name(final_names[column]);
            if (normalized !== '' && final_names.some((name, candidate) => (
                candidate !== column && normalized_column_name(name) === normalized
            ))) {
                throw new Error('Another column already has that name.');
            }
        }
    }
    const structured_column_renames = planned.flatMap((worksheet) => {
        const sheet = src.meta().sheets[worksheet.sheetIndex];
        if (sheet?.excelFirstRowHeader?.active !== true || !sheet.columnNames) return [];
        const column_names = sheet.columnNames;
        const header_row = sheet.excelFirstRowHeader.sourceRow ?? 0;
        return worksheet.edits.flatMap((edit) => {
            const old_name = column_names[edit.col];
            if (edit.row !== header_row || old_name === undefined) return [];
            const new_name = committed_column_name(edit.value);
            if (new_name === '') {
                if (old_name !== '') throw new Error('A column name cannot be blank.');
                return [];
            }
            if (
                new_name.localeCompare(old_name, undefined, { sensitivity: 'accent' }) === 0
                || column_names.filter((name) => name.localeCompare(
                    old_name, undefined, { sensitivity: 'accent' },
                ) === 0).length !== 1
            ) return [];
            return [{
                sheetIndex: worksheet.sheetIndex,
                oldName: old_name,
                newName: new_name,
            }];
        });
    });
    let too_many_calculation_edits = false;
    calculation_scan: for (const sheet of planned) {
        for (const edit of sheet.edits) {
            if (calculation_edits.length >= MAX_WORKBOOK_FORMULAS) {
                too_many_calculation_edits = true;
                calculation_edits.length = 0;
                break calculation_scan;
            }
            calculation_edits.push({
                sheetIndex: sheet.sheetIndex,
                row: edit.row,
                column: edit.col,
                value: edit.value,
                writesFormula: is_xlsx_formula_edit(edit),
                ...(edit.runs !== undefined ? { runs: edit.runs } : {}),
            });
        }
    }
    calculation_edits.sort((left, right) => (left.sheetIndex - right.sheetIndex)
        || (left.row - right.row)
        || (left.column - right.column));
    let formula_write_plan: XlsxFormulaWritePlan | undefined;
    if (
        too_many_calculation_edits
        || calculation_edits.length > 0
        || planned.some((worksheet) =>
            worksheet.structural.tailRemovals.length > 0
            || worksheet.structural.appendedRows.length > 0)
    ) {
        const sheets = src.meta().sheets;
        const planned_by_sheet = new Map(planned.map((worksheet) => [
            worksheet.sheetIndex,
            worksheet,
        ]));
        const prospective_row_counts = sheets.map((sheet, sheetIndex) => {
            const worksheet = planned_by_sheet.get(sheetIndex);
            return worksheet === undefined
                ? sheet.sourceRowCount
                : worksheet.retainedRowCount + worksheet.structural.appendedRows.length;
        });
        const removed_rows = planned.flatMap((worksheet) =>
            worksheet.structural.tailRemovals.map(({ sourceRow }) => ({
                sheetIndex: worksheet.sheetIndex,
                row: sourceRow,
            })));
        const prospective_sheets = sheets.map((sheet, sheetIndex) => ({
            ...sheet,
            sourceRowCount: prospective_row_counts[sheetIndex],
        }));
        assert_safe_workbook_formula_edits(
            prospective_sheets,
            planned.map((worksheet) => {
                const values: Record<string, string> = {};
                const formula_keys = new Set<string>();
                for (const edit of worksheet.edits) {
                    const key = `${edit.row}:${edit.col}`;
                    values[key] = edit.value;
                    if (is_xlsx_formula_edit(edit)) formula_keys.add(key);
                }
                const source_formula_cells = sheets[worksheet.sheetIndex]?.formulaCells ?? [];
                const removed = new Set(worksheet.structural.tailRemovals.map(
                    ({ sourceRow }) => sourceRow,
                ));
                for (let offset = 0; offset + 1 < source_formula_cells.length; offset += 2) {
                    const row = source_formula_cells[offset];
                    if (!removed.has(row)) continue;
                    const key = `${row}:${source_formula_cells[offset + 1]}`;
                    if (!Object.hasOwn(values, key)) values[key] = '';
                }
                return {
                    sheetIndex: worksheet.sheetIndex,
                    values,
                    isFormulaValue: (key: string) => formula_keys.has(key),
                };
            }),
        );
        const has_structural_removals = planned.some(
            (worksheet) => worksheet.structural.tailRemovals.length > 0,
        );
        const has_structural_appends = planned.some(
            (worksheet) => worksheet.structural.appendedRows.length > 0,
        );
        const formula_plan = too_many_calculation_edits
            || structured_column_renames.length > 0
            || has_structural_removals
            || has_structural_appends
            ? {
                sheetCount: prospective_sheets.length,
                impact: all_workbook_formula_cells_impact(prospective_sheets),
                targets: [],
                formulaLimitExceeded: false,
            }
            : plan_workbook_formula_recalculation(prospective_sheets, calculation_edits);
        if (formula_plan.formulaLimitExceeded) {
            throw new Error('Workbook would contain too many formulas to save safely.');
        }
        const formula_request = {
            edits: calculation_edits,
            targets: formula_plan.targets,
            prospectiveRowCounts: prospective_row_counts,
            removedRows: removed_rows,
        } satisfies FormulaCalculationRequest;
        // The package writer retargets dependent formula source for a move.
        // Results calculated here still describe the pre-move source graph, so
        // none are trustworthy; saving unknown caches is correct and lets the
        // next calculation use the rewritten formulas.
        const contains_moves = planned.some((sheet) => sheet.edits.some(
            (edit) => edit.movedFrom !== undefined,
        ));
        const calculated_results = too_many_calculation_edits
            || contains_moves
            || structured_column_renames.length > 0
            ? []
            : input.cached_formula_calculation?.(formula_request)
                ?? calculate_workbook_formulas_bounded(src, formula_request);
        formula_write_plan = create_xlsx_formula_write_plan(
            formula_plan,
            calculated_results,
        );
    }
    return {
        observed_bases: planned.map(({ observed_bases }) => observed_bases),
        observed_rich: planned.map(({ observed_rich }) => observed_rich),
        observed_links: planned.map(({ observed_links }) => observed_links),
        produce: (raw) => {
            for (const worksheet of planned) {
                const sheet = src.meta().sheets[worksheet.sheetIndex];
                for (const removal of worksheet.structural.tailRemovals) {
                    const format = capture_xlsx_append_row_format(
                        raw,
                        worksheet.sheetIndex,
                        removal.sourceRow + 1,
                        sheet.columnCount,
                        sheet.excelFirstRowHeader?.active === true
                            ? sheet.excelFirstRowHeader.sourceRow
                            : undefined,
                    );
                    const current = saved_row_physical_fingerprint({
                        cells: source_row_cells_for_fingerprint(
                            src,
                            worksheet.sheetIndex,
                            removal.sourceRow,
                        ),
                        format,
                    });
                    if (current !== saved_row_physical_fingerprint(removal.savedRow)) {
                        structural_save_error(
                            worksheet.worksheetOperationIndex,
                            worksheet.structural,
                            'savedSuffixChanged',
                            'A saved appended row changed after it was saved.',
                            {
                                pendingRowIds: [],
                                tailRemovalIds: [removal.appendHistoryId],
                            },
                        );
                    }
                }
                if (worksheet.structural.appendedRows.length === 0) continue;
                for (const template of worksheet.structural.formatTemplates) {
                    if (
                        template.format.kind !== 'xlsx'
                        || template.format.styleFingerprint
                            !== xlsx_append_style_dependency_fingerprint(
                                raw,
                                template.format.cellStyleIndexes,
                                template.format.rowStyleIndex,
                            )
                    ) structural_save_error(
                        worksheet.worksheetOperationIndex,
                        worksheet.structural,
                        'templateChanged',
                        'The workbook style table changed after rows were appended.',
                        {
                            pendingRowIds: worksheet.structural.appendedRows
                                .filter((row) => row.formatTemplateId === template.id)
                                .map((row) => row.id),
                            tailRemovalIds: [],
                        },
                    );
                }
            }
            return write_xlsx_workbook_cell_edits(
                raw,
                planned,
                formula_write_plan || structured_column_renames.length > 0 ? {
                    ...(formula_write_plan ? { formulaWritePlan: formula_write_plan } : {}),
                    ...(structured_column_renames.length > 0
                        ? { structuredColumnRenames: structured_column_renames }
                        : {}),
                } : undefined,
            );
        },
        receipt: Object.freeze({
            appendedRows: Object.freeze(planned.flatMap((worksheet) => {
                const sheet = src.meta().sheets[worksheet.sheetIndex];
                const templates = new Map(worksheet.structural.formatTemplates.map(
                    (template) => [template.id, template.format],
                ));
                return worksheet.structural.appendedRows.map((row, index) => {
                    const format = templates.get(row.formatTemplateId);
                    if (!format) throw new Error('A pending row lost its format template.');
                    return Object.freeze({
                        sheetIndex: worksheet.sheetIndex,
                        sheetName: sheet.name,
                        ...(sheet.worksheetId === undefined
                            ? {}
                            : { worksheetId: sheet.worksheetId }),
                        pendingRowId: row.id,
                        sourceRow: worksheet.retainedRowCount + index,
                        savedFingerprint: saved_pending_row_fingerprint(row, format),
                        savedRow: persisted_saved_row_snapshot(row, format, row.cells),
                    });
                });
            })),
            removedSourceRows: Object.freeze(planned.flatMap((worksheet) => {
                if (worksheet.structural.tailRemovals.length === 0) return [];
                const sheet = src.meta().sheets[worksheet.sheetIndex];
                return [Object.freeze({
                    sheetIndex: worksheet.sheetIndex,
                    sheetName: sheet.name,
                    ...(sheet.worksheetId === undefined
                        ? {}
                        : { worksheetId: sheet.worksheetId }),
                    sourceRows: Object.freeze(worksheet.structural.tailRemovals.map(
                        (removal) => removal.sourceRow,
                    )),
                })];
            })),
        }),
    };
}

function excel_profile(file_path: string): ViewerProfile {
    const base: ViewerProfileBase = {
        build_source(raw, file_path, state) {
            return build_source_from_buffer(raw, file_path, {
                excelHeaderOverrides: sanitize_excel_header_overrides(
                    state.excelFirstRowHeaders,
                ),
                excelHiddenRows: (physical_sheets) =>
                    excel_hidden_rows_for_source(physical_sheets, state.transforms),
            });
        },
    };
    // .xls is out of scope for editing: the writer above is an OOXML package
    // splice, and the binary BIFF container shares nothing with it.
    return file_path.toLowerCase().endsWith('.xlsx')
        ? { ...base, editing: true, plan_save: plan_xlsx_save, edit_syntax: 'markdown' as const }
        : { ...base, editing: false };
}

function dta_profile(): ViewerProfile {
    return {
        editing: false,
        prefer_file_source: true,
        build_source(raw, file_path) {
            return build_source_from_buffer(raw, file_path);
        },
        async build_file_source(file_path, _state, options) {
            const { FileDtaDataSource } = await import('./data-source/file-dta-source');
            return FileDtaDataSource.open_observed(
                file_path,
                true,
                options?.isCancelled,
            );
        },
    };
}

/** Build the editable CSV/TSV DataSource shared by the table and preview hosts.
 *  `csv_max_rows` comes from the host's ConfigPort; it is normalized to a
 *  finite non-negative integer. Non-finite host values fall back to the default,
 *  but a valid configured value is otherwise respected exactly. */
export function build_csv_source(
    raw: Uint8Array,
    file_path: string,
    csv_max_rows: number = MAX_CSV_ROWS,
    options?: ViewerSourceBuildOptions,
): Promise<CsvDataSource> {
    const requested_max_rows = Number.isFinite(csv_max_rows)
        ? Math.floor(csv_max_rows)
        : MAX_CSV_ROWS;
    // The banner's explicit "Load all rows" action is a per-view override: the
    // user has chosen to pay the cost for this file, without silently changing
    // the preference for every later file. Otherwise use the configured limit
    // verbatim; silently re-clamping it here makes the banner's settings action
    // ineffective as soon as the user asks for more than the default.
    const max_rows = options?.loadAllRows
        ? Number.MAX_SAFE_INTEGER
        : Math.max(0, requested_max_rows);
    return csv_source_from_buffer(raw, file_path, max_rows);
}

type CsvTextEncoder = Pick<TextEncoder, 'encode'>;

function concatenate_csv_chunks(chunks: readonly Uint8Array[]): Uint8Array {
    if (chunks.length === 0) return new Uint8Array();
    if (chunks.length === 1) return chunks[0];
    const concatenated = Buffer.concat(chunks);
    return new Uint8Array(
        concatenated.buffer,
        concatenated.byteOffset,
        concatenated.byteLength,
    );
}

function fixed_csv_bytes_producer(bytes: Uint8Array): SavePlan['produce'] {
    return () => bytes;
}

/**
 * Harvest conflict bases and prepare the complete output bytes in one traversal.
 *
 * The walk visits every row (a million is a real case), so the base harvest
 * rides along with serialization rather than making a second pass. Each source
 * window is serialized and encoded before the next is read; only encoded chunks
 * survive the loop, and they are copied once into the final write buffer.
 */
export function plan_csv_save(
    input: SavePlanInput,
    encoder: CsvTextEncoder = new TextEncoder(),
): SavePlan {
    if (input.worksheets.length !== 1 || input.worksheets[0].sheet_index !== 0) {
        throw new Error('CSV saves require exactly one worksheet payload.');
    }
    const { source: src } = input;
    const { edits, wanted_bases, structural_changes } = input.worksheets[0];
    const sheet = src.meta().sheets[0];
    if (!sheet) throw new Error('CSV source has no worksheet.');
    const structural = structural_changes ?? own_pending_structural_changes({});
    if (structural.conflicts.length > 0) {
        throw new PendingStructuralSaveError(
            0,
            structural.conflicts[0],
            'Pending rows have unresolved structural conflicts.',
        );
    }
    if (structural.formatTemplates.some((template) => template.format.kind !== 'none')) {
        throw new Error('Delimited pending rows contain an XLSX format template.');
    }
    if (structural.appendedRows.length > 0 && structural.appendBasis === undefined) {
        structural_save_error(
            0,
            structural,
            'ambiguousColumns',
            'Pending rows have no verified worksheet basis.',
        );
    }
    if (
        structural.appendBasis !== undefined
        && (structural.appendBasis.columnCount !== sheet.columnCount
            || structural.appendBasis.schemaFingerprint
                !== worksheet_append_schema_fingerprint(sheet))
    ) structural_save_error(
        0,
        structural,
        'ambiguousColumns',
        'The worksheet columns changed after rows were appended.',
    );
    // No row ceiling here: a delimited file has no workbook container to
    // overflow, so `MAX_SHEET_ROWS` never described this format.
    const retained_row_count = sheet.rowCount - structural.tailRemovals.length;
    if (retained_row_count < 0) structural_save_error(
        0,
        structural,
        'savedSuffixChanged',
        'Pending tail removals exceed the source rows.',
    );
    structural.tailRemovals.forEach((removal, index) => {
        if (removal.sourceRow !== retained_row_count + index) {
            structural_save_error(
                0,
                structural,
                'savedSuffixChanged',
                'Pending row removals are not a contiguous worksheet suffix.',
                { pendingRowIds: [], tailRemovalIds: [removal.appendHistoryId] },
            );
        }
        const current = saved_row_physical_fingerprint({
            cells: source_row_cells_for_fingerprint(src, 0, removal.sourceRow),
            format: { kind: 'none' },
        });
        if (current !== saved_row_physical_fingerprint(removal.savedRow)) {
            structural_save_error(
                0,
                structural,
                'savedSuffixChanged',
                'A saved appended row changed after it was saved.',
                { pendingRowIds: [], tailRemovalIds: [removal.appendHistoryId] },
            );
        }
    });

    // A renderer can only edit columns exposed by the source snapshot. Reject a
    // forged in-range row with an enormous column before it can widen a record
    // into billions of fields. Rows beyond the snapshot are left for the normal
    // removed-row validation so the user still receives that specific outcome.
    const assert_valid_key = (key: string) => {
        const coordinates = parse_cell_key(key);
        if (!coordinates) throw new Error('CSV save contains an invalid cell key.');
        if (
            coordinates.sourceRow < sheet.sourceRowCount
            && coordinates.sourceColumn >= sheet.columnCount
        ) {
            throw new RangeError('CSV save contains a column outside the worksheet.');
        }
    };
    for (const key in edits) {
        if (Object.prototype.hasOwnProperty.call(edits, key)) assert_valid_key(key);
    }
    for (const key of wanted_bases) assert_valid_key(key);
    for (const key of new Set([...Object.keys(edits), ...wanted_bases])) {
        const coordinates = parse_cell_key(key);
        if (
            coordinates
            && structural.tailRemovals.length > 0
            && coordinates.sourceRow >= retained_row_count
            && coordinates.sourceRow < sheet.sourceRowCount
        ) {
            throw new Error('A removed tail row also contains a source-cell edit.');
        }
    }

    const observed_bases = new Map<string, string>();
    const wanted_columns = group_cell_keys_by_source_row(wanted_bases);
    const wants_bases = wanted_columns.size > 0;
    const serializer = prepare_csv_serializer({
        delimiter: get_delimiter(input.file_path),
        edits,
        originalColumnCounts: src.originalColumnCounts,
        lineEnding: src.lineEnding,
        headerLine: src.headerLine,
    });
    const chunks: Uint8Array[] = [];
    let pending_prefix = serializer.headerPrefix;

    const row_count = retained_row_count;
    let start = 0;
    while (start < row_count) {
        const window = src.read_rows(
            0,
            start,
            structural.tailRemovals.length === 0
                ? SAVE_WINDOW
                : Math.min(SAVE_WINDOW, row_count - start),
        );
        if (
            window.startRow !== start
            || window.rows.length === 0
            || window.rows.length > SAVE_WINDOW
            || start + window.rows.length > row_count
        ) {
            throw new Error('CSV source returned an invalid row window.');
        }

        function* rows_with_observed_bases() {
            for (let offset = 0; offset < window.rows.length; offset += 1) {
                const absolute_row = start + offset;
                const row = window.rows[offset];
                const columns = wanted_columns.get(absolute_row);
                if (columns) {
                    for (const column of columns) {
                        // A column past this row's field count is left unrecorded,
                        // so validate_dirty_bases coalesces it to ''.
                        const cell = row[column];
                        if (cell === undefined) continue;
                        observed_bases.set(
                            cell_key(absolute_row, column),
                            get_raw_cell_text(cell?.raw ?? null),
                        );
                    }
                }
                yield row;
            }
        }
        const rows = wants_bases ? rows_with_observed_bases() : window.rows;
        const text = pending_prefix + serializer.serialize_rows(rows, start);
        pending_prefix = '';
        if (text.length > 0) chunks.push(encoder.encode(text));
        start += window.rows.length;
    }
    if (pending_prefix.length > 0) chunks.push(encoder.encode(pending_prefix));
    const delimiter = get_delimiter(input.file_path);
    const line_ending = src.lineEnding ?? '\n';
    for (const row of structural.appendedRows) {
        const values = Array<string>(sheet.columnCount).fill('');
        for (const [column_text, cell] of Object.entries(row.cells)) {
            const column = Number(column_text);
            if (column >= sheet.columnCount) {
                throw new Error('A pending row contains a column outside the worksheet.');
            }
            if (cell.valueRuns !== undefined || cell.link) {
                throw new Error('Delimited pending rows cannot contain rich text or hyperlinks.');
            }
            values[column] = cell.value;
        }
        chunks.push(encoder.encode(serialize_delimited_values(
            values,
            delimiter,
            line_ending,
        )));
    }

    // Eager rather than inside `produce`: the caller reads `observed_bases`
    // immediately and allocation failures remain planning failures. Build the
    // producer in a separate scope so it retains only the final bytes, never the
    // chunk array or source windows used to assemble them.
    const bytes = concatenate_csv_chunks(chunks);
    return {
        observed_bases: [observed_bases],
        produce: fixed_csv_bytes_producer(bytes),
        receipt: Object.freeze({
            appendedRows: Object.freeze(structural.appendedRows.map((row, index) => ({
                sheetIndex: 0,
                sheetName: sheet.name,
                ...(sheet.worksheetId === undefined ? {} : { worksheetId: sheet.worksheetId }),
                pendingRowId: row.id,
                sourceRow: retained_row_count + index,
                savedFingerprint: saved_pending_row_fingerprint(row, { kind: 'none' }),
                savedRow: persisted_saved_row_snapshot(row, { kind: 'none' }, row.cells),
            }))),
            removedSourceRows: structural.tailRemovals.length === 0
                ? Object.freeze([])
                : Object.freeze([{
                    sheetIndex: 0,
                    sheetName: sheet.name,
                    ...(sheet.worksheetId === undefined
                        ? {}
                        : { worksheetId: sheet.worksheetId }),
                    sourceRows: Object.freeze(structural.tailRemovals.map(
                        (removal) => removal.sourceRow,
                    )),
                }]),
        }),
    };
}

export function csv_source_builder(config?: ConfigPort): ViewerProfile['build_source'] {
    return (raw, file_path, _state, options) =>
        build_csv_source(raw, file_path, config?.csv_max_rows(), options);
}

export function csv_table_profile(config?: ConfigPort): ViewerProfile {
    return {
        editing: true,
        plan_save: plan_csv_save,
        append_row_ceiling: UNBOUNDED_SHEET_ROWS,
        build_source: csv_source_builder(config),
    };
}

/** The row ceiling an append must respect for this profile's format.
 *  Workbook formats keep `MAX_SHEET_ROWS`; delimited formats have none. */
export function append_row_ceiling_for(profile: ViewerProfile): number {
    return profile.append_row_ceiling ?? MAX_SHEET_ROWS;
}

/**
 * The same ceiling, shaped for the webview capability that carries it.
 *
 * `null` stands for "no ceiling". The resolved value is
 * `UNBOUNDED_SHEET_ROWS` — `Number.POSITIVE_INFINITY` — and nothing guarantees
 * a non-finite number survives the trip to the webview intact.
 */
export function projected_append_row_ceiling(
    profile: ViewerProfile,
): number | null {
    const ceiling = append_row_ceiling_for(profile);
    return Number.isFinite(ceiling) ? ceiling : null;
}

/** Whether two paths would take the same parser — the comparison `profile_for`
 *  makes, without building anything. */
function same_extension(left: string, right: string): boolean {
    const extension = (path: string) => path.toLowerCase().slice(path.lastIndexOf('.'));
    return extension(left) === extension(right);
}

/** Profile for a path: CSV/TSV are editable; all other registered formats are read-only unless their profile opts into editing. */
export function profile_for(file_path: string, config?: ConfigPort): ViewerProfile {
    const ext = file_path.toLowerCase();
    return ext.endsWith('.csv') || ext.endsWith('.tsv')
        ? csv_table_profile(config)
        : ext.endsWith('.dta')
            ? dta_profile()
        : excel_profile(file_path);
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
    const compare_original_uri = options.compare
        ? create_resource_identity(options.compare.originalUri).uri
        : undefined;
    const compare_mode = compare_original_uri !== undefined;
    /**
     * Whether editing exists for this panel at all. A compare panel is
     * read-only regardless of the profile, and the guard must hold on the
     * *host* side — the snapshot capabilities hide the edit UI, but a stale or
     * buggy renderer could still post requestEditSession/saveCsv/edit
     * messages, and only this flag stands between those and the working-tree
     * file. Every edit gate below reads this, never profile.editing directly.
     */
    const editing_supported = profile.editing && !compare_mode && !options.readOnly;
    let compare_unavailable_warned = false;
    /**
     * The unfetched Git LFS object one of this panel's sides turned out to be,
     * or undefined in the ordinary case. Set while building a source and read
     * when projecting the snapshot, so the banner appears with the very
     * delivery that carries the empty (or undiffed) grid.
     *
     * Held on the controller rather than derived from the adopted source
     * because a *failed resolve* has to change it while the source stays
     * exactly as it was — the grid does not move, only the banner's message.
     */
    let unresolved_lfs: UnresolvedLfsObject | undefined;
    /**
     * Record that a side is an unfetched pointer, carrying over a failure
     * already attached to the *same* object.
     *
     * The carry-over is what makes a failed resolve legible. Reporting a
     * failure re-delivers the snapshot, that delivery rebuilds the source, and
     * the rebuild finds the very same pointer again — so a plain assignment
     * here would erase the explanation between attaching it and rendering it,
     * leaving the banner silently unchanged after a click. Matched on side and
     * oid, so a *different* pointer legitimately starts clean.
     */
    function note_unresolved_lfs(
        side: UnresolvedLfsObject['side'],
        pointer: { readonly oid: string; readonly size: number },
    ): void {
        const carried = unresolved_lfs?.side === side && unresolved_lfs.oid === pointer.oid
            ? unresolved_lfs.failure
            : undefined;
        unresolved_lfs = {
            side,
            oid: pointer.oid,
            size: pointer.size,
            resolvable: host.gitLfs !== undefined,
            ...(carried === undefined ? {} : { failure: carried }),
        };
    }
    /**
     * Bytes fetched for a compare original that was a pointer, keyed by oid.
     *
     * Only the original side is cached, and only in memory. A working-tree
     * pointer is fixed on disk by `pull`, so the next read finds real bytes and
     * there is nothing to remember; the original side has no disk state to fix
     * — a `git:` read returns the committed pointer blob forever — so without
     * this every refresh of a resolved comparison would re-download the object.
     */
    let resolved_lfs_original: { readonly oid: string; readonly content: Uint8Array }
        | undefined;
    /**
     * The same, for the *main* side when it is not a working-tree file.
     *
     * A comparison's modified side can itself be a `git:` revision — staged
     * against HEAD, say — and then the panel's own `uri` is a committed blob
     * that no `pull` can change: `git lfs pull` repairs the working tree, which
     * this side is not reading. Without this, resolving such a panel reported
     * success (the working-tree file really is smudged) while the next read
     * returned the pointer again, so the banner came back on every click.
     */
    let resolved_lfs_main: { readonly oid: string; readonly content: Uint8Array }
        | undefined;
    /** Guards against concurrent resolves from repeated banner clicks. */
    let lfs_resolve_in_flight = false;
    /**
     * Set when the renderer asks to abandon a comparison that is still
     * aligning. Alignment is what makes the diff correct, so there is nothing
     * useful to show once it is abandoned — the request closes the window.
     */
    let compare_alignment_cancelled = false;
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
    let file_edit_state = editing_supported
        ? csv_edit_file_states.get(file_key)
        : undefined;
    if (editing_supported && !file_edit_state) {
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
    let source_observation: Readonly<PhysicalSourceObservation> | undefined;
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
    /**
     * What a replay lease retains, so a commit mutates only what preparation
     * verified.
     *
     * Everything a commit needs is here, and a commit message contributes NO
     * coordinates of its own: it names cells by the ordinal preparation assigned,
     * so a stale or hostile renderer cannot reach a cell the host never checked.
     * The captured host identities are what make the lease self-invalidating —
     * see the currency predicate built alongside each one.
     */
    interface ReplayLeasePayload {
        readonly cells: readonly HistoryReplayPreparedCell[];
        readonly highlights: readonly HistoryReplayHighlightInput[];
        readonly structures: readonly (HistoryReplayStructuralInput & {
            readonly resolvedSheetIndex: number;
        })[];
        readonly rowAdmissionRequestIds: readonly string[];
        /** Each prepared highlight's resolved sheet, by ordinal. */
        readonly highlightSheetIndices: ReadonlyMap<number, number>;
        readonly focus: HistoryReplayFocus;
        readonly focusSheetIndex: number;
        readonly sourceGeneration: number;
        /** Whether the host state the lease was bound to is still in place. */
        readonly isCurrent: () => boolean;
    }
    interface HistoryReplayCommitOutcome {
        readonly result: HistoryReplayCommitted | HistoryReplayCommitRefused;
        /** Publish the durable highlight arm after the terminal reaches the renderer. */
        readonly publishCurrentMaterial: boolean;
    }
    let release_dropped_replay_lease: (lease: {
        readonly leaseId: string;
        readonly payload: ReplayLeasePayload;
    }, reason: 'expired' | 'abandoned' | 'invalidated' | 'cleared') => void = () => {};
    const replay_leases = create_history_replay_lease_registry<
        ReplayLeasePayload,
        HistoryReplayCommitOutcome
    >((lease, reason) => release_dropped_replay_lease(lease, reason));
    let replay_preparation_in_flight = false;
    /**
     * The commit operation a taken lease is running, so a retransmission can join
     * the one mutation instead of waiting on an answer that may never come.
     */
    let active_replay_commit:
        | Promise<HistoryReplayCommitOutcome>
        | undefined;
    let active_save_operation: CsvSaveHostOperation | undefined;
    let active_save_drain: Promise<void> = Promise.resolve();
    let disposal_edit_release_drain: Promise<void> = Promise.resolve();
    // Save identities whose edits `persist_accepted_save` wrote into durable state.
    // A failed save only needs a tombstone if it got that far; see the write site in
    // `release_edit_session`. Weak so a retired operation's entry goes with it —
    // A normal terminal lifecycle's operation is the only strong reference either way.
    const persisted_save_targets = new WeakMap<CsvSaveOperation, readonly WorksheetTarget[]>();
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
    const pending_sheet_selections = new Set<{
        readonly sheetName: string;
        readonly resolve: (found: boolean) => void;
        readonly reject: (error: Error) => void;
    }>();
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
    // Per-view, deliberately not persisted. A later physical refresh stays fully
    // loaded; reopening the file returns to the configured limit.
    let load_all_csv_rows = false;
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
    /** The workbook-scoped session grant currently owned by this panel. */
    let active_edit_session_id: string | undefined;
    interface AppendAdmissionLedger {
        /** All row identities this host has ever issued in the live edit session. */
        readonly ownedRowIds: Set<string>;
        /** Exact format-template capability issued for each row identity. */
        readonly templateIdByRowId: Map<string, string>;
        /** Issued rows not yet observed in a complete renderer publication. */
        /** Row ID -> first complete publication sequence that can retire it. */
        readonly reservedRowIds: Map<string, number>;
        /** Reservations awaiting the renderer's explicit install/cancel verdict. */
        readonly unsettledRequestByRowId: Map<string, string>;
        /** Exact structural basis issued for this worksheet in the session. */
        appendBasis?: PendingAppendBasis;
        sourceGeneration: number;
        formatTemplate?: PendingRowFormatTemplate;
    }
    /**
     * Host authority for temporary identities. A save may accept an ID only if
     * it came from durable restored state or this edit-session ledger.
     */
    const append_admission_ledgers = new Map<string, AppendAdmissionLedger>();
    interface RowAdmissionReservation {
        readonly purpose: 'append' | 'restoration';
        readonly editSessionId: string;
        readonly ledgerKey: string;
        /** Complete row set the admission gesture restores or appends. */
        readonly gestureRowIds: readonly string[];
        readonly rowIds: readonly string[];
        readonly appendBasis: PendingAppendBasis;
        readonly templates: readonly PendingRowFormatTemplate[];
        readonly templateAuthorityOwner: string;
        readonly appendTemplate?: PendingRowFormatTemplate;
        readonly sourceGeneration: number;
        state: 'unsettled' | 'accepted';
        firstPublicationSequence?: number;
        replayLeaseId?: string;
    }
    const row_admission_reservations = new Map<string, RowAdmissionReservation>();
    /** Request IDs stay live until their reservation is cancelled or published. */
    const row_admission_request_ids = new Set<string>();
    // The template budget is shared by every worksheet, so its authority
    // transitions use one tail even though the row ledgers themselves are keyed
    // per worksheet. Holding this tail through publication makes the capacity
    // preflight below remain true until the post-CAS commit.
    const APPEND_ADMISSION_AUTHORITY_TAIL = '\u0000append-admission-authority';
    const append_admission_tails = new Map<string, Promise<void>>();
    interface AppendAdmissionAuthorityFence {
        readonly ready: Promise<void>;
        release(): void;
    }
    /** Install a synchronous queue barrier, then expose when prior authority work drained. */
    const fence_append_admission_authority = (): AppendAdmissionAuthorityFence => {
        const prior = append_admission_tails.get(APPEND_ADMISSION_AUTHORITY_TAIL)
            ?? Promise.resolve();
        const ready = prior.catch(() => {});
        let release_hold!: () => void;
        const hold = new Promise<void>((resolve) => { release_hold = resolve; });
        const tail = ready.then(() => hold);
        append_admission_tails.set(APPEND_ADMISSION_AUTHORITY_TAIL, tail);
        let released = false;
        return {
            ready,
            release: () => {
                if (released) return;
                released = true;
                release_hold();
                void tail.then(() => {
                    if (append_admission_tails.get(APPEND_ADMISSION_AUTHORITY_TAIL) === tail) {
                        append_admission_tails.delete(APPEND_ADMISSION_AUTHORITY_TAIL);
                    }
                });
            },
        };
    };
    const append_admission_template_authorities = new AppendAdmissionTemplateAuthorityStore(
        MAX_SAVED_APPEND_AUTHORITY_BYTES,
    );
    const ledger_template_authority_owner = (ledger_key: string): string =>
        `ledger:${ledger_key}`;
    const reservation_template_authority_owner = (request_id: string): string =>
        `reservation:${request_id}`;
    // History-reachable unsaved row capabilities. These are populated only from
    // IDs a live host ledger actually issued; renderer retention messages can
    // keep such a capability alive but cannot mint one.
    const retained_pending_append_keys = new Set<string>();
    const retained_pending_append_authorities = new RetainedPendingAppendAuthorityStore(
        MAX_SAVED_APPEND_AUTHORITY_BYTES,
    );
    interface SavedAppendAuthority {
        readonly worksheet: WorksheetTarget;
        readonly appendHistoryId: string;
        readonly sourceRow: number;
        readonly savedFingerprint: string;
        readonly savedRow: SavedAppendedRowSnapshot;
        readonly byteCost: number;
        state: 'physical' | 'removed';
    }
    /**
     * Capabilities for the only physical rows structural Undo may remove.
     *
     * They deliberately outlive an edit session: Save fences and releases that
     * session before the user can invoke cross-save Undo. They do not outlive the
     * panel/document history that needs them. A durable in-flight tail removal is
     * allowed to seed the same capability after renderer reload, but only from a
     * snapshot previously accepted into host-owned state.
     */
    const saved_append_authorities = new Map<string, SavedAppendAuthority>();
    let saved_append_authority_bytes = 0;
    const saved_append_authority_byte_cost = (
        authority: Omit<SavedAppendAuthority, 'byteCost'>,
    ): number => Buffer.byteLength(JSON.stringify({
        worksheet: authority.worksheet,
        appendHistoryId: authority.appendHistoryId,
        sourceRow: authority.sourceRow,
        savedFingerprint: authority.savedFingerprint,
        savedRow: authority.savedRow,
    }), 'utf8') + 256;
    const forget_saved_append_authority = (key: string): void => {
        const prior = saved_append_authorities.get(key);
        if (prior === undefined) return;
        saved_append_authorities.delete(key);
        saved_append_authority_bytes -= prior.byteCost;
    };
    const remember_saved_append_authority = (
        key: string,
        authority: Omit<SavedAppendAuthority, 'byteCost'>,
    ): void => {
        forget_saved_append_authority(key);
        const owned = { ...authority, byteCost: saved_append_authority_byte_cost(authority) };
        saved_append_authorities.set(key, owned);
        saved_append_authority_bytes += owned.byteCost;
        while (
            saved_append_authorities.size > MAX_SAVED_APPEND_AUTHORITIES
            || saved_append_authority_bytes > MAX_SAVED_APPEND_AUTHORITY_BYTES
        ) {
            const oldest = saved_append_authorities.keys().next().value as string | undefined;
            if (oldest === undefined) break;
            forget_saved_append_authority(oldest);
        }
    };
    const canonical_worksheet_target = (
        target: WorksheetTarget,
        sheets: readonly SheetMeta[] | undefined = source?.meta().sheets,
    ): WorksheetTarget | undefined => {
        if (!sheets) return undefined;
        const sheet_index = worksheet_target_index(sheets, target);
        const sheet = sheet_index === undefined ? undefined : sheets[sheet_index];
        if (sheet_index === undefined || !sheet) return undefined;
        return {
            sheetIndex: sheet_index,
            sheetName: sheet.name,
            ...(sheet.worksheetId === undefined ? {} : { worksheetId: sheet.worksheetId }),
        };
    };
    const saved_append_authority_key = (
        target: WorksheetTarget,
        append_history_id: string,
    ): string | undefined => {
        const canonical = canonical_worksheet_target(target);
        return canonical === undefined
            ? undefined
            : `${worksheet_target_key(canonical)}\u0000${append_history_id}`;
    };
    const saved_append_authority_for = (
        target: WorksheetTarget,
        append_history_id: string,
    ): SavedAppendAuthority | undefined => {
        const key = saved_append_authority_key(target, append_history_id);
        return key === undefined ? undefined : saved_append_authorities.get(key);
    };
    const tail_removal_matches_authority = (
        target: WorksheetTarget,
        removal: PendingTailRemoval,
        state: SavedAppendAuthority['state'] = 'physical',
    ): boolean => {
        const authority = saved_append_authority_for(target, removal.appendHistoryId);
        return authority !== undefined
            && authority.state === state
            && authority.sourceRow === removal.sourceRow
            && authority.savedFingerprint === removal.savedFingerprint
            && saved_row_snapshot_fingerprint(removal.savedRow)
                === authority.savedFingerprint;
    };
    const seed_durable_tail_removal_authority = (
        target: WorksheetTarget,
        removal: PendingTailRemoval,
    ): void => {
        const key = saved_append_authority_key(target, removal.appendHistoryId);
        const canonical = canonical_worksheet_target(target);
        if (
            key === undefined
            || canonical === undefined
            || saved_append_authorities.has(key)
            || saved_row_snapshot_fingerprint(removal.savedRow) !== removal.savedFingerprint
        ) return;
        remember_saved_append_authority(key, {
            worksheet: canonical,
            appendHistoryId: removal.appendHistoryId,
            sourceRow: removal.sourceRow,
            savedFingerprint: removal.savedFingerprint,
            savedRow: removal.savedRow,
            state: 'physical',
        });
    };
    const commit_saved_append_authorities = (
        operation: CsvSaveHostOperation,
        receipt: import('./types').PendingChangesSaveReceipt | undefined,
        persisted_snapshots: ReadonlyMap<
            string,
            SavedAppendedRowSnapshot
        > = new Map(),
    ): void => {
        for (const [worksheet_index, worksheet] of operation.identity.worksheets.entries()) {
            const structural = worksheet.structuralChanges;
            if (!structural) continue;
            const target = operation.durableTargets[worksheet_index] ?? worksheet;
            for (const removal of structural.tailRemovals) {
                const authority = saved_append_authority_for(
                    target,
                    removal.appendHistoryId,
                );
                if (authority !== undefined) authority.state = 'removed';
            }
            const templates = new Map(structural.formatTemplates.map(
                (template) => [template.id, template.format],
            ));
            for (const assignment of receipt?.appendedRows ?? []) {
                if (!worksheet_target_matches(assignment, target)) continue;
                const row = structural.appendedRows.find(
                    (candidate) => candidate.id === assignment.pendingRowId,
                );
                const format = row === undefined
                    ? undefined
                    : templates.get(row.formatTemplateId);
                const canonical = canonical_worksheet_target(target);
                const key = saved_append_authority_key(target, assignment.pendingRowId);
                if (row === undefined || format === undefined || canonical === undefined || !key) {
                    continue;
                }
                const persisted = persisted_snapshots.get(assignment.pendingRowId)
                    ?? assignment.savedRow
                    ?? persisted_saved_row_snapshot(row, format, row.cells);
                remember_saved_append_authority(key, {
                    worksheet: canonical,
                    appendHistoryId: assignment.pendingRowId,
                    sourceRow: assignment.sourceRow,
                    savedFingerprint: assignment.savedFingerprint,
                    savedRow: persisted,
                    state: 'physical',
                });
            }
        }
    };
    const append_ledger_key = (session_id: string, target: WorksheetTarget) =>
        `${session_id}\u0000${worksheet_target_key(target)}`;
    const pending_append_history_key = (target_key: string, row_id: string): string =>
        `${target_key}\u0000${row_id}`;
    const appended_rows_match_ledger = (
        ledger: AppendAdmissionLedger | undefined,
        rows: readonly PendingAppendedRow[],
    ): boolean => rows.length === 0 || (ledger !== undefined && rows.every((row) =>
        ledger.ownedRowIds.has(row.id)
        && ledger.templateIdByRowId.get(row.id) === row.formatTemplateId));
    const unsettled_reservation_for_ledger = (
        ledger_key: string,
    ): RowAdmissionReservation | undefined => {
        for (const reservation of row_admission_reservations.values()) {
            if (reservation.ledgerKey === ledger_key && reservation.state === 'unsettled') {
                return reservation;
            }
        }
        return undefined;
    };
    const reservations_for_ledger = (
        ledger_key: string,
    ): readonly [string, RowAdmissionReservation][] => [...row_admission_reservations]
        .filter(([, reservation]) => reservation.ledgerKey === ledger_key);
    /** An admitted gesture may be omitted or included whole, never split. */
    const row_admission_gestures_are_complete = (
        reservations: readonly RowAdmissionReservation[],
        rows: readonly PendingAppendedRow[],
    ): boolean => {
        const row_ids = new Set(rows.map((row) => row.id));
        return reservations.every((reservation) => {
            const included = reservation.gestureRowIds.filter((row_id) =>
                row_ids.has(row_id)).length;
            return included === 0 || included === reservation.gestureRowIds.length;
        });
    };
    const accepted_row_admission_gestures_are_complete = (
        ledger_key: string,
        rows: readonly PendingAppendedRow[],
    ): boolean => row_admission_gestures_are_complete(
        reservations_for_ledger(ledger_key)
            .map(([, reservation]) => reservation)
            .filter((reservation) => reservation.state === 'accepted'),
        rows,
    );
    const accepted_append_basis_for_ledger = (
        ledger: AppendAdmissionLedger | undefined,
        ledger_key: string,
        additionally_authorized: ReadonlySet<string> = new Set(),
    ): PendingAppendBasis | undefined => {
        let basis = ledger?.appendBasis;
        for (const [request_id, reservation] of reservations_for_ledger(ledger_key)) {
            if (
                reservation.state !== 'accepted'
                && !additionally_authorized.has(request_id)
            ) continue;
            if (basis === undefined) {
                basis = reservation.appendBasis;
                continue;
            }
            const advanced = advance_pending_append_basis(basis, reservation.appendBasis);
            if (advanced !== undefined) basis = advanced;
        }
        return basis;
    };
    const issued_append_template = (
        ledger: AppendAdmissionLedger | undefined,
        ledger_key: string,
        template_id: string,
        additionally_authorized: ReadonlySet<string> = new Set(),
    ): PendingRowFormatTemplate | undefined => {
        const committed = ledger === undefined
            ? undefined
            : append_admission_template_authorities.get(
                ledger_template_authority_owner(ledger_key),
                template_id,
            );
        if (committed !== undefined) return committed;
        for (const [request_id, reservation] of reservations_for_ledger(ledger_key)) {
            if (
                reservation.state !== 'accepted'
                && !additionally_authorized.has(request_id)
            ) continue;
            const issued = reservation.templates.find((template) => template.id === template_id);
            if (issued !== undefined) return issued;
        }
        return undefined;
    };
    const changes_use_unsettled_row_authority = (
        ledger: AppendAdmissionLedger | undefined,
        ledger_key: string,
        rows: readonly PendingAppendedRow[],
        templates: readonly PendingRowFormatTemplate[],
        append_basis?: PendingAppendBasis,
        additionally_authorized: ReadonlySet<string> = new Set(),
    ): boolean => {
        if (ledger === undefined) {
            return rows.length > 0 || templates.length > 0 || append_basis !== undefined;
        }
        if (rows.some((row) => {
            const request_id = ledger.unsettledRequestByRowId.get(row.id);
            return request_id !== undefined && !additionally_authorized.has(request_id);
        })) return true;
        const committed_owner = ledger_template_authority_owner(ledger_key);
        if (templates.some((template) => (
            append_admission_template_authorities.get(committed_owner, template.id) === undefined
            && reservations_for_ledger(ledger_key).some(([request_id, reservation]) =>
                reservation.state === 'unsettled'
                && !additionally_authorized.has(request_id)
                && reservation.templates.some((candidate) => candidate.id === template.id))
        ))) return true;
        if (append_basis === undefined) return false;
        const accepted = accepted_append_basis_for_ledger(
            ledger,
            ledger_key,
            additionally_authorized,
        );
        return JSON.stringify(accepted) !== JSON.stringify(append_basis)
            && reservations_for_ledger(ledger_key).some(([request_id, reservation]) => (
                reservation.state === 'unsettled'
                && !additionally_authorized.has(request_id)
                && JSON.stringify(reservation.appendBasis) === JSON.stringify(append_basis)
            ));
    };

    interface PendingStructuralPublicationPlan {
        readonly ledgerKey: string;
        readonly priorLedger: AppendAdmissionLedger | undefined;
        readonly nextLedger: AppendAdmissionLedger | undefined;
        readonly retiringReservations: readonly [string, RowAdmissionReservation][];
        readonly templateAdditions: readonly PendingRowFormatTemplate[];
        readonly durableChanges: WorksheetPendingChanges;
    }

    const clone_append_admission_ledger = (
        ledger: AppendAdmissionLedger,
    ): AppendAdmissionLedger => ({
        ownedRowIds: new Set(ledger.ownedRowIds),
        templateIdByRowId: new Map(ledger.templateIdByRowId),
        reservedRowIds: new Map(ledger.reservedRowIds),
        unsettledRequestByRowId: new Map(ledger.unsettledRequestByRowId),
        ...(ledger.appendBasis === undefined ? {} : { appendBasis: ledger.appendBasis }),
        sourceGeneration: ledger.sourceGeneration,
        ...(ledger.formatTemplate === undefined
            ? {}
            : { formatTemplate: ledger.formatTemplate }),
    });

    const project_retained_pending_rows = (
        ledger: AppendAdmissionLedger | undefined,
        target: WorksheetTarget,
        rows: readonly PendingAppendedRow[],
    ): ReadonlyMap<string, PendingRowFormatTemplate> => {
        const templates = new Map<string, PendingRowFormatTemplate>();
        if (ledger === undefined || rows.length === 0) return templates;
        const target_key = worksheet_target_key(target);
        for (const row of rows) {
            const authority = retained_pending_append_authorities.get(target_key, row.id);
            if (authority === undefined) continue;
            if (ledger.ownedRowIds.size >= MAX_PENDING_APPENDED_ROWS) break;
            if (
                ledger.appendBasis !== undefined
                && authority.appendBasis !== undefined
                && advance_pending_append_basis(
                    ledger.appendBasis,
                    authority.appendBasis,
                ) === undefined
                && advance_pending_append_basis(
                    authority.appendBasis,
                    ledger.appendBasis,
                ) === undefined
            ) continue;
            if (row.formatTemplateId !== authority.formatTemplateId) continue;
            ledger.ownedRowIds.add(row.id);
            ledger.templateIdByRowId.set(row.id, authority.formatTemplateId);
            templates.set(authority.formatTemplate.id, authority.formatTemplate);
            if (authority.appendBasis !== undefined) {
                const advanced = ledger.appendBasis === undefined
                    ? authority.appendBasis
                    : advance_pending_append_basis(
                        ledger.appendBasis,
                        authority.appendBasis,
                    );
                if (advanced !== undefined) ledger.appendBasis = advanced;
            }
        }
        return templates;
    };

    /**
     * Validate and project one renderer publication without consuming authority.
     * The returned transition is installed only after its durable state write.
     */
    const plan_pending_structural_publication = (
        edit_session_id: string,
        target: WorksheetTarget,
        changes: WorksheetPendingChanges,
        sequence: number,
        verify_template_capacity = false,
    ): PendingStructuralPublicationPlan | undefined => {
        const ledger_key = append_ledger_key(edit_session_id, target);
        const prior_ledger = append_admission_ledgers.get(ledger_key);
        const next_ledger = prior_ledger === undefined
            ? undefined
            : clone_append_admission_ledger(prior_ledger);
        // A refused plan is a silently dropped publication upstream, so each
        // refusal names its check; the caller logs the sequence and session.
        const refuse = (reason: string, detail?: Record<string, unknown>) => {
            console.warn('Refused a pending structural publication plan', {
                reason,
                ledgerKey: ledger_key,
                hasLedger: prior_ledger !== undefined,
                ownedRows: prior_ledger?.ownedRowIds.size ?? 0,
                postedRows: changes.appendedRows.length,
                ...detail,
            });
            return undefined;
        };
        if (changes_use_unsettled_row_authority(
            prior_ledger,
            ledger_key,
            changes.appendedRows,
            changes.formatTemplates,
            changes.appendBasis,
        )) return refuse('unsettled-row-authority');

        const retiring_reservations = reservations_for_ledger(ledger_key).filter(
            ([, reservation]) => reservation.state === 'accepted'
                && reservation.firstPublicationSequence !== undefined
                && sequence >= reservation.firstPublicationSequence,
        );
        if (!row_admission_gestures_are_complete(
            retiring_reservations.map(([, reservation]) => reservation),
            changes.appendedRows,
        )) return refuse('split-admission-gesture');
        const published_row_ids = new Set(changes.appendedRows.map((row) => row.id));

        const staged_templates = new Map(project_retained_pending_rows(
            next_ledger,
            target,
            changes.appendedRows,
        ));

        const provisional_ledger_basis = accepted_append_basis_for_ledger(
            next_ledger,
            ledger_key,
        );
        if (!appended_rows_match_ledger(next_ledger, changes.appendedRows)) {
            return refuse('rows-not-owned-by-ledger', {
                unowned: changes.appendedRows
                    .filter((row) => !next_ledger?.ownedRowIds.has(row.id)).length,
                templateMismatched: changes.appendedRows
                    .filter((row) => next_ledger?.ownedRowIds.has(row.id)
                        && next_ledger.templateIdByRowId.get(row.id)
                            !== row.formatTemplateId).length,
            });
        }
        if (changes.formatTemplates.some((template) => {
            const issued = staged_templates.get(template.id)
                ?? issued_append_template(
                    next_ledger,
                    ledger_key,
                    template.id,
                );
            return issued === undefined
                || JSON.stringify(issued) !== JSON.stringify(template);
        })) return refuse('unissued-format-template');
        if (
            changes.appendBasis !== undefined
            && JSON.stringify(changes.appendBasis)
                !== JSON.stringify(provisional_ledger_basis)
        ) {
            return refuse('append-basis-mismatch', {
                posted: changes.appendBasis,
                authorized: provisional_ledger_basis,
            });
        }
        if (changes.tailRemovals.some(
            (removal) => !tail_removal_matches_authority(target, removal),
        )) return refuse('tail-removal-unauthorized');

        const retiring_ids = new Set(retiring_reservations.map(([request_id]) => request_id));
        for (const [, reservation] of retiring_reservations) {
            const included = reservation.gestureRowIds.every((row_id) =>
                published_row_ids.has(row_id));
            const retained_ids = new Set(reservation.rowIds.filter((row_id) =>
                retained_pending_append_keys.has(pending_append_history_key(
                    worksheet_target_key(target),
                    row_id,
                ))));
            const keeps_authority = included || retained_ids.size > 0;
            if (keeps_authority && next_ledger !== undefined) {
                const advanced = next_ledger.appendBasis === undefined
                    ? reservation.appendBasis
                    : advance_pending_append_basis(
                        next_ledger.appendBasis,
                        reservation.appendBasis,
                    );
                if (advanced === undefined) return undefined;
                next_ledger.appendBasis = advanced;
                for (const template of reservation.templates) {
                    staged_templates.set(template.id, template);
                }
                if (reservation.appendTemplate !== undefined) {
                    next_ledger.formatTemplate = reservation.appendTemplate;
                }
                next_ledger.sourceGeneration = reservation.sourceGeneration;
            }
            for (const row_id of reservation.rowIds) {
                next_ledger?.reservedRowIds.delete(row_id);
                next_ledger?.unsettledRequestByRowId.delete(row_id);
                if (included || retained_ids.has(row_id)) continue;
                next_ledger?.ownedRowIds.delete(row_id);
                next_ledger?.templateIdByRowId.delete(row_id);
            }
        }

        let authorized_basis = next_ledger?.appendBasis;
        for (const [request_id, reservation] of reservations_for_ledger(ledger_key)) {
            if (retiring_ids.has(request_id) || reservation.state !== 'accepted') continue;
            if (authorized_basis === undefined) {
                authorized_basis = reservation.appendBasis;
                continue;
            }
            const advanced = advance_pending_append_basis(
                authorized_basis,
                reservation.appendBasis,
            );
            if (advanced !== undefined) authorized_basis = advanced;
        }
        if (changes.appendedRows.length === 0) authorized_basis = undefined;
        if (changes.appendedRows.length > 0 && authorized_basis === undefined) return undefined;
        const { appendBasis: _posted_basis, ...changes_without_basis } = changes;
        const durable_changes: WorksheetPendingChanges = Object.freeze({
            ...changes_without_basis,
            ...(authorized_basis === undefined ? {} : { appendBasis: authorized_basis }),
        });
        try {
            assert_pending_changes_encoded_bound(durable_changes);
        } catch {
            return undefined;
        }
        const retiring_template_owners = retiring_reservations.map(([, reservation]) =>
            reservation.templateAuthorityOwner);
        if (
            verify_template_capacity
            && (retiring_template_owners.length > 0 || staged_templates.size > 0)
            && !append_admission_template_authorities.can_commit_many(
                retiring_template_owners,
                ledger_template_authority_owner(ledger_key),
                [...staged_templates.values()],
            )
        ) return undefined;
        return {
            ledgerKey: ledger_key,
            priorLedger: prior_ledger,
            nextLedger: next_ledger,
            retiringReservations: Object.freeze(retiring_reservations),
            templateAdditions: Object.freeze([...staged_templates.values()]),
            durableChanges: durable_changes,
        };
    };

    const commit_pending_structural_publication = (
        plan: PendingStructuralPublicationPlan,
    ): boolean => {
        if (append_admission_ledgers.get(plan.ledgerKey) !== plan.priorLedger) return false;
        if (plan.retiringReservations.some(([request_id, reservation]) =>
            row_admission_reservations.get(request_id) !== reservation
            || reservation.state !== 'accepted')) return false;
        if (
            (plan.retiringReservations.length > 0 || plan.templateAdditions.length > 0)
            && !append_admission_template_authorities.commit_many(
                plan.retiringReservations.map(([, reservation]) =>
                    reservation.templateAuthorityOwner),
                ledger_template_authority_owner(plan.ledgerKey),
                plan.templateAdditions,
            )
        ) return false;
        if (plan.nextLedger === undefined) {
            append_admission_ledgers.delete(plan.ledgerKey);
        } else {
            append_admission_ledgers.set(plan.ledgerKey, plan.nextLedger);
        }
        for (const [request_id] of plan.retiringReservations) {
            row_admission_reservations.delete(request_id);
            row_admission_request_ids.delete(request_id);
        }
        return true;
    };
    type ResolvedReplayStructure = HistoryReplayStructuralInput & {
        readonly resolvedSheetIndex: number;
    };
    /** Exact unsettled restoration capabilities one replay is allowed to consume. */
    const replay_row_admissions_for_structures = (
        request_ids: readonly string[],
        structures: readonly ResolvedReplayStructure[],
        source_generation: number,
        replay_lease_id?: string,
    ): ReadonlySet<string> | undefined => {
        if (request_ids.length === 0) return new Set();
        const edit_session_id = active_edit_session_id;
        if (edit_session_id === undefined) return undefined;
        const structure_by_ledger = new Map<string, ResolvedReplayStructure>();
        for (const structural of structures) {
            const target = canonical_worksheet_target({
                ...structural.worksheet,
                sheetIndex: structural.resolvedSheetIndex,
            });
            if (target === undefined) return undefined;
            structure_by_ledger.set(
                append_ledger_key(edit_session_id, target),
                structural,
            );
        }
        const seen_gesture_rows = new Set<string>();
        for (const request_id of request_ids) {
            const reservation = row_admission_reservations.get(request_id);
            const structural = reservation === undefined
                ? undefined
                : structure_by_ledger.get(reservation.ledgerKey);
            if (
                reservation === undefined
                || structural === undefined
                || reservation.purpose !== 'restoration'
                || reservation.editSessionId !== edit_session_id
                || reservation.sourceGeneration !== source_generation
                || reservation.state !== 'unsettled'
                || reservation.replayLeaseId !== replay_lease_id
            ) return undefined;
            const expected_ids = new Set(structural.expected.appendedRows.map((row) => row.id));
            const desired_rows = new Map(structural.desired.appendedRows.map(
                (row) => [row.id, row],
            ));
            for (const row_id of reservation.gestureRowIds) {
                if (
                    expected_ids.has(row_id)
                    || !desired_rows.has(row_id)
                    || seen_gesture_rows.has(`${reservation.ledgerKey}\u0000${row_id}`)
                ) return undefined;
                seen_gesture_rows.add(`${reservation.ledgerKey}\u0000${row_id}`);
            }
            const desired_templates = new Map(structural.desired.formatTemplates.map(
                (template) => [template.id, template],
            ));
            if (reservation.templates.some((template) => (
                JSON.stringify(desired_templates.get(template.id))
                    !== JSON.stringify(template)
            ))) return undefined;
            if (
                structural.desired.appendBasis === undefined
                || advance_pending_append_basis(
                    reservation.appendBasis,
                    structural.desired.appendBasis,
                ) === undefined
            ) return undefined;
        }
        return new Set(request_ids);
    };

    const lease_replay_row_admissions = (
        request_ids: readonly string[],
        replay_lease_id: string,
    ): boolean => {
        if (request_ids.some((request_id) => {
            const reservation = row_admission_reservations.get(request_id);
            return reservation === undefined
                || reservation.state !== 'unsettled'
                || reservation.replayLeaseId !== undefined;
        })) return false;
        for (const request_id of request_ids) {
            row_admission_reservations.get(request_id)!.replayLeaseId = replay_lease_id;
        }
        return true;
    };

    const release_replay_row_admissions = (
        request_ids: readonly string[],
        replay_lease_id: string,
    ): void => {
        for (const request_id of request_ids) {
            const reservation = row_admission_reservations.get(request_id);
            if (reservation?.replayLeaseId === replay_lease_id) {
                reservation.replayLeaseId = undefined;
            }
        }
    };
    const cancel_replay_row_admissions = (
        request_ids: readonly string[],
        replay_lease_id: string,
    ): void => {
        for (const request_id of request_ids) {
            const reservation = row_admission_reservations.get(request_id);
            if (reservation === undefined) continue;
            settle_row_admission({
                type: 'settleRowAdmission',
                requestId: request_id,
                editSessionId: reservation.editSessionId,
                accepted: false,
            }, replay_lease_id);
        }
    };
    release_dropped_replay_lease = (lease, reason) => {
        if (reason === 'invalidated' || reason === 'cleared') {
            cancel_replay_row_admissions(
                lease.payload.rowAdmissionRequestIds,
                lease.leaseId,
            );
            return;
        }
        release_replay_row_admissions(
            lease.payload.rowAdmissionRequestIds,
            lease.leaseId,
        );
    };

    const accept_replay_row_admissions = (
        request_ids: readonly string[],
        replay_lease_id: string,
    ): boolean => {
        const reservations = request_ids.map((request_id) =>
            row_admission_reservations.get(request_id));
        if (reservations.some((reservation) => reservation === undefined
            || reservation.state !== 'unsettled'
            || reservation.replayLeaseId !== replay_lease_id)) return false;
        return request_ids.every((request_id, index) => settle_row_admission({
            type: 'settleRowAdmission',
            requestId: request_id,
            editSessionId: reservations[index]!.editSessionId,
            accepted: true,
        }, replay_lease_id));
    };
    const clear_append_admission_session = (session_id: string): void => {
        const prefix = `${session_id}\u0000`;
        for (const [request_id, reservation] of row_admission_reservations) {
            if (reservation.editSessionId === session_id) {
                const ledger = append_admission_ledgers.get(reservation.ledgerKey);
                if (
                    reservation.state === 'accepted'
                    && ledger !== undefined
                    && reservation.rowIds.some((id) => {
                        const target_key = reservation.ledgerKey.slice(prefix.length);
                        return retained_pending_append_keys.has(
                            pending_append_history_key(target_key, id),
                        );
                    })
                ) {
                    const advanced = ledger.appendBasis === undefined
                        ? reservation.appendBasis
                        : advance_pending_append_basis(
                            ledger.appendBasis,
                            reservation.appendBasis,
                    );
                    if (advanced !== undefined) ledger.appendBasis = advanced;
                    if (!append_admission_template_authorities.commit(
                        reservation.templateAuthorityOwner,
                        ledger_template_authority_owner(reservation.ledgerKey),
                        reservation.templates,
                    )) {
                        append_admission_template_authorities.forget_owner(
                            reservation.templateAuthorityOwner,
                        );
                    }
                    if (reservation.appendTemplate !== undefined) {
                        ledger.formatTemplate = reservation.appendTemplate;
                    }
                } else {
                    append_admission_template_authorities.forget_owner(
                        reservation.templateAuthorityOwner,
                    );
                }
                row_admission_reservations.delete(request_id);
                row_admission_request_ids.delete(request_id);
            }
        }
        for (const [key, ledger] of append_admission_ledgers) {
            if (!key.startsWith(prefix)) continue;
            const target_key = key.slice(prefix.length);
            const retained_ids = [...ledger.ownedRowIds].filter((id) =>
                retained_pending_append_keys.has(pending_append_history_key(target_key, id)));
            if (retained_ids.length > 0) {
                for (const id of retained_ids) {
                    const format_template_id = ledger.templateIdByRowId.get(id);
                    const format_template = format_template_id === undefined
                        ? undefined
                        : append_admission_template_authorities.get(
                            ledger_template_authority_owner(key),
                            format_template_id,
                        );
                    if (format_template_id === undefined || format_template === undefined) continue;
                    retained_pending_append_authorities.remember(target_key, id, {
                        formatTemplate: format_template,
                        formatTemplateId: format_template_id,
                        ...(ledger.appendBasis === undefined
                            ? {}
                            : { appendBasis: ledger.appendBasis }),
                        sourceGeneration: ledger.sourceGeneration,
                    });
                }
            }
            append_admission_ledgers.delete(key);
            append_admission_template_authorities.forget_owner(
                ledger_template_authority_owner(key),
            );
        }
        for (const key of append_admission_tails.keys()) {
            if (key.startsWith(prefix)) append_admission_tails.delete(key);
        }
    };
    /**
     * Seed the append-admission ledgers from durable pending changes.
     *
     * An edit-session grant seeds the granted sheet's slot inline, but a
     * rehydration claim (`project_state_for_panel`) acquires the session with
     * no grant round-trip at all. Without this seeding, the restored appended
     * rows republish against an empty ledger, the publication is refused as
     * unsettled row authority and silently dropped, and closing the window
     * times the acknowledgment fence out into the unsafe-close dialog — on
     * every launch, because the durable rows come back each time.
     */
    const seed_durable_append_admissions = (
        edit_session_id: string,
        slots: PerFileState['pendingEdits'],
        sheets: readonly WorksheetIdentityInput[],
    ): void => {
        const reconciled = reconcile_pending_edit_sheets(slots, sheets);
        if (!reconciled) return;
        for (let sheet_index = 0; sheet_index < reconciled.length; sheet_index += 1) {
            const sheet = sheets[sheet_index];
            const identity = sheet === undefined ? undefined : worksheet_identity(sheet);
            const slot = pending_changes_for_sheet(
                reconciled,
                sheet_index,
                identity?.name,
                identity?.worksheetId,
            );
            if (!slot) continue;
            let structural: PendingStructuralChanges;
            try {
                structural = own_pending_structural_changes(slot);
            } catch {
                continue;
            }
            if (
                structural.appendedRows.length === 0
                && structural.tailRemovals.length === 0
                && structural.appendBasis === undefined
            ) continue;
            const target: WorksheetTarget = {
                sheetIndex: sheet_index,
                ...(identity?.name === undefined ? {} : { sheetName: identity.name }),
                ...(identity?.worksheetId === undefined
                    ? {}
                    : { worksheetId: identity.worksheetId }),
            };
            const key = append_ledger_key(edit_session_id, target);
            const ledger = append_admission_ledgers.get(key) ?? {
                ownedRowIds: new Set<string>(),
                templateIdByRowId: new Map<string, string>(),
                reservedRowIds: new Map<string, number>(),
                unsettledRequestByRowId: new Map<string, string>(),
                sourceGeneration: core?.source_generation ?? 0,
            };
            for (const row of structural.appendedRows) {
                ledger.ownedRowIds.add(row.id);
                ledger.templateIdByRowId.set(row.id, row.formatTemplateId);
            }
            for (const template of structural.formatTemplates) {
                append_admission_template_authorities.remember(
                    ledger_template_authority_owner(key),
                    template,
                );
            }
            ledger.appendBasis = structural.appendBasis;
            for (const removal of structural.tailRemovals) {
                seed_durable_tail_removal_authority(target, removal);
            }
            append_admission_ledgers.set(key, ledger);
        }
    };
    // The worksheet currently shown in edit mode and worksheets with a pending
    // publication that has not crossed the durable state boundary. Neither is
    // ownership — the grant remains workbook-scoped. Together they are the
    // volatile evidence needed to release when a reload removes every place an
    // unpublished editor can still exist, without treating every worksheet ever
    // visited during the session as permanently live.
    const active_edit_session_targets = new Map<string, WorksheetTarget>();
    const pending_edit_session_targets = new Map<
        string,
        Map<string, { target: WorksheetTarget; sequence: number }>
    >();
    const excel_header_subscriber_token = Symbol(file_key);
    const cell_highlight_subscriber_token = Symbol(file_key);
    const header_receipt_queue: ExcelHeaderOperationReceipt[] = [];
    let header_receipt_processing = false;
    let header_refresh_scheduled = false;
    const released_sources = new WeakSet<DataSource>();
    const released_cores = new WeakSet<ViewerPanelCore>();
    const compare_diff_failure_notified = new WeakSet<CompareDataSource>();
    const compare_diff_sidecars = new Set<Promise<void>>();

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
            options.integrationTestPort?.on_host_message(message);
            return Promise.resolve(webview.postMessage(message)).catch(() => false);
        } catch {
            return Promise.resolve(false);
        }
    }

    /**
     * Answer a served row page with its compare diff. Invoked by the core with
     * the exact window `rowData` carried — clamped and transform-projected — so
     * the diff describes the rows the renderer received, keyed by the same
     * display positions. `sourceRows` maps each display row back to the source
     * row the diff is defined over, so an arbitrarily transformed window is
     * diffed in one batch.
     */
    async function post_compare_diff(
        msg: Extract<WebviewMessage, { type: 'requestRows' }>,
        window: { startRow: number; sourceRows: number[] },
        receiver_epoch: number,
    ): Promise<void> {
        if (!(source instanceof CompareDataSource) || window.sourceRows.length === 0) return;
        const compare_source = source;
        const source_generation = core?.source_generation;
        const is_cancelled = () =>
            disposed
            || source !== compare_source
            || session.current_receiver_epoch !== receiver_epoch
            || core?.source_generation !== source_generation
            || core?.generation !== msg.generation;
        let diff;
        try {
            // The diff is positional over the compare source's projected row
            // space; the window carries canonical rows, so map them back.
            const projected_rows = window.sourceRows.map((source_row) =>
                compare_source.projected_row_index(msg.sheetIndex, source_row));
            if (projected_rows.some((row) => row === undefined)) return;
            diff = await compare_source.diff_rows(
                msg.sheetIndex,
                projected_rows as number[],
                is_cancelled,
            );
        } catch (error) {
            if (is_cancelled() || is_abort_error(error)) return;
            if (!compare_diff_failure_notified.has(compare_source)) {
                compare_diff_failure_notified.add(compare_source);
                log_sanitized_failure('Failed to compare a visible table page', error);
                host.ui.show_warning(COMPARE_DIFF_INCOMPLETE_WARNING);
            }
            return;
        }
        if (!diff || is_cancelled()) return;
        await post_to_receiver({
            type: 'compareDiff',
            sheetIndex: msg.sheetIndex,
            startRow: window.startRow,
            // Positional results: entry i / row offsets are display slots
            // startRow + i of the served window, matching rowData's rows.
            rowStatus: diff.rowStatus,
            changedCells: diff.changedCells.map((cell) => ({
                ...cell,
                row: window.startRow + cell.row,
            })),
            requestId: msg.requestId,
            generation: msg.generation,
        }, receiver_epoch);
    }

    function start_compare_diff(
        msg: Extract<WebviewMessage, { type: 'requestRows' }>,
        window: { startRow: number; sourceRows: number[] },
        receiver_epoch: number,
    ): void {
        let sidecar!: Promise<void>;
        sidecar = post_compare_diff(msg, window, receiver_epoch)
            .catch((error) => {
                if (is_abort_error(error)) return;
                try {
                    log_sanitized_failure(
                        'Failed to finish a visible table page comparison',
                        error,
                    );
                } catch {
                    // This is the terminal containment boundary: VS Code does not
                    // observe promises returned from event listeners, and even a
                    // failing logger must not turn a row sidecar into an unhandled
                    // rejection.
                }
            })
            .finally(() => { compare_diff_sidecars.delete(sidecar); });
        compare_diff_sidecars.add(sidecar);
    }

    function flush_sheet_selections(): void {
        if (
            disposed
            || !renderer_ready
            || !session.acknowledged_current()
            || !source
            || active_save_dialog_request
        ) return;
        for (const request of [...pending_sheet_selections]) {
            const sheets = source.meta().sheets;
            let sheet_index = sheets.findIndex((sheet) => sheet.name === request.sheetName);
            if (sheet_index === -1 && /^[1-9]\d*$/.test(request.sheetName)) {
                const ordinal = Number(request.sheetName);
                if (Number.isSafeInteger(ordinal) && ordinal <= sheets.length) {
                    sheet_index = ordinal - 1;
                }
            }
            if (sheet_index === -1) {
                pending_sheet_selections.delete(request);
                request.resolve(false);
                continue;
            }
            pending_sheet_selections.delete(request);
            void post_to_receiver({ type: 'selectSheet', sheetIndex: sheet_index })
                .then((posted) => {
                    if (posted) request.resolve(true);
                    else request.reject(new Error('The Table Viewer renderer is unavailable.'));
                });
        }
    }

    function select_sheet(sheet_name: string): Promise<boolean> {
        if (disposed) return Promise.reject(new Error('Viewer controller is disposed.'));
        return new Promise<boolean>((resolve, reject) => {
            pending_sheet_selections.add({ sheetName: sheet_name, resolve, reject });
            flush_sheet_selections();
        });
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

    // The coordinator watches the file this panel is attached to, which in a
    // comparison is only the modified side. The original is just as live —
    // regenerate it and the window would otherwise keep showing a diff against
    // bytes that no longer exist — so it gets a watcher of its own here.
    // `refresh_if_changed` re-stats both sides and rebuilds only on a real
    // change, so an event that turns out to be noise costs two stats.
    if (compare_original_uri) {
        try {
            const original_watcher = host.refreshWatcherFactory.create(
                create_resource_identity(compare_original_uri),
            );
            const listener = original_watcher.on_event(() => {
                if (disposed) return;
                void refresh_if_changed().catch(() => {});
            });
            disposables.push({
                dispose() {
                    listener.dispose();
                    original_watcher.dispose();
                },
            });
        } catch (error) {
            // A missing watcher degrades the window to manual refresh; it must
            // not take the comparison down with it.
            log_sanitized_failure('Failed to watch the comparison original', error);
        }
    }

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

    /** A prepared or committing undo/redo owns the same durable pending-edit
     * projection a save snapshots and later clears. Neither operation may start
     * while the other owns that projection. */
    function history_replay_blocks_save(): boolean {
        return replay_preparation_in_flight
            || replay_leases.current(Date.now()) !== undefined;
    }

    /** Mirror of history_replay_blocks_save for replay admission. */
    function save_blocks_history_replay(): boolean {
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
     * — so each site now names its own policy, such as `may_begin_editing`,
     * `may_retain_capability`, and `may_reserve_claim`. Rehydrating durable work does
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
     * The worksheet name at `sheet_index`, for tagging a persisted edit slot so a
     * workbook reordered externally cannot reattach it to the wrong sheet. Absent
     * when no source is adopted, which is the legacy-slot shape and equally safe:
     * an untagged slot is only ever reattached by position, which is what the old
     * file-scoped leaf did unconditionally.
     */
    function sheet_name_at(sheet_index: number): string | undefined {
        return source?.meta().sheets[sheet_index]?.name;
    }

    function worksheet_id_at(sheet_index: number): string | undefined {
        return source?.meta().sheets[sheet_index]?.worksheetId;
    }

    /**
     * The same snapshot with its pending-edit slots placed against `next`'s sheets.
     *
     * The durable leaf is positional, and the workbook being adopted may have
     * reordered since it was written. Every other reader of durable state gets
     * this for free by going through `normalize_host_state` on the way to a
     * write; the adoption projection reads a snapshot directly, so it has to ask.
     *
     * Identity is preserved when nothing moved, so an adoption that changes
     * nothing still hands `project_state_for_panel` the object it was given.
     */
    function reconciled_against(
        snapshot: Readonly<FileStateSnapshot>,
        next: DataSource,
        commit_append_authority = true,
    ): Readonly<FileStateSnapshot> {
        const state = snapshot.state as PerFileState;
        if (!state.pendingEdits) return snapshot;
        const reconciled = reconcile_pending_edit_sheets(
            state.pendingEdits,
            next.meta().sheets,
        );
        let projected = reconciled;
        if (projected) {
            let next_slots: typeof projected | undefined;
            for (let sheet_index = 0; sheet_index < projected.length; sheet_index += 1) {
                const slot = projected[sheet_index];
                const sheet = next.meta().sheets[sheet_index];
                if (!slot || !sheet) continue;
                const structural = own_pending_structural_changes(slot);
                const basis = structural.appendBasis;
                if (basis === undefined || structural.appendedRows.length === 0) continue;
                const schema_fingerprint = worksheet_append_schema_fingerprint(sheet);
                const schema_changed = basis.columnCount !== sheet.columnCount
                    || basis.schemaFingerprint !== schema_fingerprint;
                // A wider source preserves every pending column identity. A
                // narrower source is safe only when the columns it discards do
                // not carry pending content. Content in retained columns does
                // not make a presentation-only width reconciliation ambiguous.
                const has_truncated_content = sheet.columnCount < basis.columnCount
                    && structural.appendedRows.some((row) =>
                        Object.entries(row.cells).some(([column, cell]) =>
                            Number(column) >= sheet.columnCount
                            && (cell.value !== ''
                                || cell.valueRuns !== undefined
                                || cell.link != null))
                        || Object.keys(row.highlights ?? {}).some(
                            (column) => Number(column) >= sheet.columnCount,
                        ));
                const without_prior = structural.conflicts.filter((conflict) =>
                    conflict.reason !== 'ambiguousColumns'
                    && conflict.reason !== 'templateChanged');
                const reconciliation_conflict_slot = (
                    reason: 'ambiguousColumns' | 'templateChanged',
                    pending_row_ids: readonly string[],
                ) => {
                    const conflicted = {
                        ...slot,
                        conflicts: Object.freeze([
                            ...without_prior,
                            Object.freeze({
                                reason,
                                pendingRowIds: Object.freeze(pending_row_ids.slice(
                                    0,
                                    MAX_ACTIONABLE_STRUCTURAL_CONFLICT_ROW_IDS,
                                )),
                                tailRemovalIds: Object.freeze([]),
                            }),
                        ]),
                    };
                    assert_pending_changes_encoded_bound(conflicted);
                    return conflicted;
                };
                // A zero-width worksheet has no legal append schema. Even a
                // blank pending row cannot be resized to it: PendingAppendBasis
                // intentionally requires a positive column count at every
                // durable and wire boundary.
                if (has_truncated_content || sheet.columnCount === 0) {
                    next_slots ??= projected.slice();
                    next_slots[sheet_index] = reconciliation_conflict_slot(
                        'ambiguousColumns',
                        structural.appendedRows.map((row) => row.id),
                    );
                    continue;
                }
                const resize = <T,>(
                    values: readonly T[],
                    fill: () => T,
                ): readonly T[] => Object.freeze(Array.from(
                    { length: sheet.columnCount },
                    (_unused, column) => column < values.length
                        ? values[column] as T
                        : fill(),
                ));
                // Compare the dependencies that survive the width change. A
                // removed blank column may have had a style, but that style no
                // longer participates in the appended row and cannot make the
                // retained template stale.
                const changed_template_ids = new Set(structural.formatTemplates.flatMap(
                    (template) => {
                        if (template.format.kind !== 'xlsx') return [];
                        const fingerprint = next.append_style_dependency_fingerprint?.bind(next);
                        if (fingerprint === undefined) return [template.id];
                        const retained_count = Math.min(
                            sheet.columnCount,
                            basis.columnCount,
                        );
                        const slot_fingerprints = template.format.cellStyleFingerprints;
                        if (slot_fingerprints === undefined) {
                            // Legacy templates have only an aggregate hash. It
                            // remains comparable across growth, but cannot prove
                            // that a retained subset survived a shrink.
                            if (sheet.columnCount < basis.columnCount) return [template.id];
                            if (fingerprint(
                                template.format.cellStyleIndexes,
                                template.format.rowStyleIndex,
                            ) !== template.format.styleFingerprint) return [template.id];
                        } else {
                            for (let column = 0; column < retained_count; column += 1) {
                                if (fingerprint(
                                    [template.format.cellStyleIndexes[column] ?? null],
                                    template.format.rowStyleIndex,
                                ) !== slot_fingerprints[column]) return [template.id];
                            }
                        }
                        if (
                            sheet.columnCount > basis.columnCount
                            && template.format.rowStyleIndex !== undefined
                            && (template.format.rowNumberFormat === undefined
                                || template.format.rowFontStyle === undefined)
                        ) return [template.id];
                        return [];
                    },
                ));
                if (changed_template_ids.size > 0) {
                    next_slots ??= projected.slice();
                    next_slots[sheet_index] = reconciliation_conflict_slot(
                        'templateChanged',
                        structural.appendedRows
                            .filter((row) => changed_template_ids.has(row.formatTemplateId))
                            .map((row) => row.id),
                    );
                    continue;
                }
                if (!schema_changed) {
                    // Style-only refreshes must still run the dependency check
                    // above. When the style returns to the admitted recipe, also
                    // retire the conflict without rewriting otherwise-identical
                    // row/template state.
                    if (without_prior.length !== structural.conflicts.length) {
                        next_slots ??= projected.slice();
                        next_slots[sheet_index] = {
                            ...slot,
                            conflicts: Object.freeze(without_prior),
                        };
                    }
                    continue;
                }
                // With no value/highlight attached to a column identity, a width
                // change can only add or discard blank presentation slots. Keep
                // row identity/order and resize the interned XLSX recipes.
                const templates = structural.formatTemplates.map((template) => {
                    if (template.format.kind !== 'xlsx') return template;
                    const format = template.format;
                    const cellStyleIndexes = resize(
                        format.cellStyleIndexes,
                        () => null,
                    );
                    const styleFingerprint = next.append_style_dependency_fingerprint?.(
                        cellStyleIndexes,
                        format.rowStyleIndex,
                    );
                    if (styleFingerprint === undefined) return template;
                    const cellStyleFingerprints = Object.freeze(cellStyleIndexes.map((style) =>
                        next.append_style_dependency_fingerprint!(
                            [style],
                            format.rowStyleIndex,
                        )));
                    return Object.freeze({
                        ...template,
                        format: Object.freeze({
                            ...format,
                            styleFingerprint,
                            cellStyleIndexes,
                            cellStyleFingerprints,
                            ...(format.cellNumberFormats === undefined
                                ? {}
                                : {
                                    cellNumberFormats: resize(
                                        format.cellNumberFormats,
                                        () => format.rowStyleIndex === undefined
                                            ? null
                                            : format.rowNumberFormat ?? null,
                                    ),
                                }),
                            ...(format.cellFontStyles === undefined
                                ? {}
                                : {
                                    cellFontStyles: resize(
                                        format.cellFontStyles,
                                        () => format.rowStyleIndex === undefined
                                            ? { bold: false, italic: false }
                                            : format.rowFontStyle
                                                ?? { bold: false, italic: false },
                                    ),
                                }),
                        }),
                    });
                });
                const reconciled_xlsx_template = templates.find(
                    (template) => template.format.kind === 'xlsx',
                );
                const reconciled_style_fingerprint = reconciled_xlsx_template?.format.kind
                    === 'xlsx'
                    ? reconciled_xlsx_template.format.styleFingerprint
                    : undefined;
                const appendBasis: PendingAppendBasis = Object.freeze({
                    ...basis,
                    columnCount: sheet.columnCount,
                    schemaFingerprint: schema_fingerprint,
                    ...(basis.styleFingerprint === undefined ? {} : {
                        styleFingerprint: reconciled_style_fingerprint
                            ?? basis.styleFingerprint,
                    }),
                });
                const reconciled_slot = {
                    ...slot,
                    formatTemplates: Object.freeze(templates),
                    appendBasis,
                    conflicts: Object.freeze(without_prior),
                };
                let candidate_is_bounded = true;
                try {
                    // Width growth can repeat one row-level display recipe into
                    // thousands of new slots. Measure the complete durable leaf
                    // without first materializing its JSON representation.
                    assert_pending_user_changes_encoded_bound(reconciled_slot);
                } catch {
                    candidate_is_bounded = false;
                }
                const reconciled_template_ids = new Set(templates.flatMap(
                    (template, index) => template === structural.formatTemplates[index]
                        ? []
                        : [template.id],
                ));
                let ledger: AppendAdmissionLedger | undefined;
                let ledger_key: string | undefined;
                if (active_edit_session_id !== undefined) {
                    const target: WorksheetTarget = {
                        sheetIndex: sheet_index,
                        sheetName: sheet.name,
                        ...(sheet.worksheetId === undefined
                            ? {}
                            : { worksheetId: sheet.worksheetId }),
                    };
                    ledger_key = append_ledger_key(active_edit_session_id, target);
                    ledger = append_admission_ledgers.get(ledger_key);
                    if (
                        candidate_is_bounded
                        && commit_append_authority
                        && ledger !== undefined
                        && !append_admission_template_authorities.replace(
                            ledger_template_authority_owner(ledger_key),
                            templates,
                        )
                    ) {
                        candidate_is_bounded = false;
                    }
                }
                next_slots ??= projected.slice();
                if (!candidate_is_bounded) {
                    next_slots[sheet_index] = reconciliation_conflict_slot(
                        'templateChanged',
                        structural.appendedRows
                            .filter((row) => reconciled_template_ids.has(
                                row.formatTemplateId,
                            ))
                            .map((row) => row.id),
                    );
                    continue;
                }
                next_slots[sheet_index] = reconciled_slot;
                if (
                    commit_append_authority
                    && ledger !== undefined
                    && ledger_key !== undefined
                ) {
                    ledger.appendBasis = appendBasis;
                }
            }
            projected = next_slots ?? projected;
        }
        if (projected && file_path.toLowerCase().endsWith('.xlsx')) {
            let next_slots: typeof projected | undefined;
            for (let formula_index = 0; formula_index < projected.length; formula_index += 1) {
                const slot = projected[formula_index];
                if (!slot) continue;
                const formula_structural = own_pending_structural_changes(slot);
                const formula_cells = projected.flatMap((target_slot, target_index) =>
                    target_slot
                        ? pending_formula_cells_referencing_provisional_rows(
                            formula_structural,
                            slot.cells,
                            own_pending_structural_changes(target_slot),
                            formula_index,
                            target_index,
                            next.meta().sheets,
                        )
                        : []);
                const unique_formula_cells = [...new Map(formula_cells.map((cell) => [
                    cell.rowIdentity.kind === 'source'
                        ? `source:${cell.rowIdentity.sourceRow}:${cell.sourceColumn}`
                        : `pending:${cell.rowIdentity.pendingRowId}:${cell.sourceColumn}`,
                    cell,
                ])).values()];
                const ambiguous = unique_formula_cells.length > 0;
                const without_prior = formula_structural.conflicts.filter(
                    (conflict) => conflict.reason !== 'ambiguousPendingFormula',
                );
                if (!ambiguous) {
                    if (without_prior.length === formula_structural.conflicts.length) continue;
                    next_slots ??= projected.slice();
                    next_slots[formula_index] = {
                        ...slot,
                        conflicts: Object.freeze(without_prior),
                    };
                    continue;
                }
                // Conflicts are actionable diagnostics, not a mirror of the
                // entire workbook. Cap them before deriving row ids so a large
                // workbook cannot inflate the durable state payload toward the
                // webview message limit.
                const actionable_formula_cells = unique_formula_cells.slice(0, 16);
                next_slots ??= projected.slice();
                const conflicted = {
                    ...slot,
                    conflicts: Object.freeze([
                        ...without_prior,
                        Object.freeze({
                            reason: 'ambiguousPendingFormula' as const,
                            pendingRowIds: Object.freeze([...new Set(
                                actionable_formula_cells.flatMap((cell) =>
                                    cell.rowIdentity.kind === 'pending'
                                        ? [cell.rowIdentity.pendingRowId]
                                        : []),
                            )]),
                            tailRemovalIds: Object.freeze([]),
                            formulaCells: Object.freeze(actionable_formula_cells),
                        }),
                    ]),
                };
                assert_pending_changes_encoded_bound(conflicted);
                next_slots[formula_index] = conflicted;
            }
            projected = next_slots ?? projected;
        }
        if (projected === state.pendingEdits) return snapshot;
        if (projected) {
            return { revision: snapshot.revision, state: { ...state, pendingEdits: projected } };
        }
        const { pendingEdits: _drop, ...rest } = state;
        return { revision: snapshot.revision, state: rest };
    }

    function sheet_index_identified(
        worksheet_id: string | undefined,
        sheet_name: string | undefined,
        sheets: readonly WorksheetIdentityInput[] = source?.meta().sheets ?? [],
    ): number | undefined {
        if (worksheet_id === undefined && sheet_name === undefined) return undefined;
        return worksheet_target_index(sheets, {
            sheetIndex: 0,
            sheetName: sheet_name,
            worksheetId: worksheet_id,
        });
    }

    function set_active_edit_session_target(
        edit_session_id: string,
        target: WorksheetTarget,
    ): void {
        active_edit_session_targets.set(edit_session_id, target);
    }

    function observe_pending_edit_target(
        edit_session_id: string,
        target: WorksheetTarget,
        sequence: number,
    ): void {
        let targets = pending_edit_session_targets.get(edit_session_id);
        if (!targets) {
            targets = new Map();
            pending_edit_session_targets.set(edit_session_id, targets);
        }
        targets.set(worksheet_target_key(target), { target, sequence });
    }

    function retire_pending_edit_target(
        edit_session_id: string,
        target: WorksheetTarget,
        sequence: number,
    ): void {
        const targets = pending_edit_session_targets.get(edit_session_id);
        if (!targets) return;
        const key = worksheet_target_key(target);
        if (targets.get(key)?.sequence !== sequence) return;
        targets.delete(key);
        if (targets.size === 0) pending_edit_session_targets.delete(edit_session_id);
    }

    function volatile_edit_targets_survive(
        edit_session_id: string,
        sheets: readonly WorksheetIdentityInput[],
    ): boolean {
        const active_target = active_edit_session_targets.get(edit_session_id);
        if (
            active_target
            && worksheet_target_index(sheets, active_target) !== undefined
        ) return true;
        for (const { target } of
            pending_edit_session_targets.get(edit_session_id)?.values() ?? []) {
            if (worksheet_target_index(sheets, target) !== undefined) return true;
        }
        return false;
    }

    /**
     * Should a rehydrating panel claim a session for these durable slots?
     *
     * Yes when any slot describes a worksheet the workbook actually has: an
     * untagged slot (single-sheet CSV by construction, no name to check), or a
     * tagged slot whose name resolves somewhere. The session is workbook-scoped,
     * so one live slot is enough — the claim covers them all, and the projection
     * decides per sheet what to show.
     *
     * No when every occupied slot is *parked* — tagged for a worksheet the
     * workbook does not have. Reconciliation parks such a slot at its own index
     * rather than deleting it (a rename and a deletion are indistinguishable
     * from the tag alone), so the index is where the draft was last seen and
     * says nothing about what sits there now. Claiming a session over parked
     * drafts alone would project nothing and still lock the file's edit phase;
     * the drafts stay durable and reappear the moment the workbook has their
     * names again.
     */
    function has_rehydratable_pending_edits(
        slots: PerFileState['pendingEdits'],
        sheets: readonly WorksheetIdentityInput[] = source?.meta().sheets ?? [],
    ): boolean {
        if (!slots) return true;
        const target_index = worksheet_target_lookup(sheets);
        let parked = false;
        for (const [sheetIndex, slot] of slots.entries()) {
            if (!slot) continue;
            if (slot.worksheetId === undefined && slot.sheetName === undefined) return true;
            if (target_index({
                sheetIndex,
                sheetName: slot.sheetName,
                worksheetId: slot.worksheetId,
            }) !== undefined) return true;
            // Parked: skipped, and remembered, so the fall-through below can tell
            // "every slot is parked" from "there are no slots".
            parked = true;
        }
        // An all-holes array names no sheet at all and blocks nothing.
        return !parked;
    }

    /**
     * Keys of the durable pending edits the *current* session owns, which is what
     * `hiddenEditedCellKeys` is drawn from. Scoped through
     * `pending_edits_for_current_session` so a retired save's or another session's
     * tombstoned entries — durably present but not this session's to show — cannot
     * be counted as work the user is holding.
     *
     * Sheet-qualified, because editing is worksheet-scoped: the caller intersects
     * these keys with one sheet's row permutation, so returning another sheet's
     * keys would report edits hidden that are not.
     */
    function durable_pending_edit_keys(sheet_index: number): readonly string[] {
        // The session is workbook-scoped, so any sheet's slot can carry this
        // session's keys; `pending_edits_for_sheet` already answers per sheet,
        // which keeps the intersection with that sheet's row permutation honest.
        const sheet = source?.meta().sheets[sheet_index];
        const scoped = pending_edits_for_current_session(
            pending_edits_for_sheet(
                durable_pending_edits,
                sheet_index,
                sheet?.name,
                sheet?.worksheetId,
            ),
        );
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
     * already in flight: a reopened panel holding durable pending edits always gets
     * its session back, because
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

    function adopt_save_lifecycle<T extends CsvSaveLifecycle>(lifecycle: T): T {
        save_lifecycle = lifecycle;
        recapture_edit_capabilities();
        return lifecycle;
    }

    function begin_save_lifecycle(
        operation: CsvSaveOperation,
    ): ActiveCsvSaveLifecycle {
        return adopt_save_lifecycle(Object.freeze<ActiveCsvSaveLifecycle>({
            revision: save_lifecycle.revision + 1,
            state: 'active',
            operation,
        }));
    }

    function finish_save_lifecycle(
        operation: CsvSaveOperation,
        state: 'failed',
    ): Extract<CsvSaveLifecycle, { state: 'failed'; operation: CsvSaveOperation }>;
    function finish_save_lifecycle(
        operation: CsvSaveOperation,
        state: 'succeeded',
    ): Extract<CsvSaveLifecycle, { state: 'succeeded' }>;
    function finish_save_lifecycle(
        operation: CsvSaveOperation,
        state: 'failed' | 'succeeded',
    ): Extract<CsvSaveLifecycle, { state: 'failed' | 'succeeded'; operation: CsvSaveOperation }> {
        const revision = save_lifecycle.revision + 1;
        const lifecycle = state === 'failed'
            ? Object.freeze({ revision, state: 'failed' as const, operation })
            : Object.freeze({ revision, state: 'succeeded' as const, operation });
        return adopt_save_lifecycle(lifecycle);
    }

    function finish_malformed_save_lifecycle(
        correlation: CsvSaveCorrelation,
    ): Extract<CsvSaveLifecycle, { failure: 'malformedRequest' }> {
        return adopt_save_lifecycle(Object.freeze({
            revision: save_lifecycle.revision + 1,
            state: 'failed' as const,
            failure: 'malformedRequest' as const,
            correlation,
        }));
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
        const correlation = save_lifecycle_correlation(save_lifecycle);
        if (
            edit_session_id !== undefined
            && correlation?.editSessionId !== edit_session_id
        ) return false;
        adopt_save_lifecycle(Object.freeze<CsvSaveLifecycle>({
            revision: save_lifecycle.revision + 1,
            state: 'idle',
        }));
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

    /**
     * The operation is no longer current *because its worksheet moved under it*.
     *
     * Distinguished from every other way currency is lost, because this one has no
     * other actor to clean up after it. A superseded operation was replaced by one
     * that owns the lifecycle; a released session retires it on the way out. But a
     * reorder mid-save leaves `active_save_operation` installed and the lifecycle
     * `active` with nobody holding either, and the bare `return`s below would strand
     * it there: no further save could start, no pending-edit post would be admitted,
     * transforms would stay blocked, and any edits `persist_accepted_save` already
     * committed would keep their cleanup obligation unmet. Callers throw on this so
     * the existing catch runs the ordinary failed-save path.
     */
    function save_sheet_moved(operation: CsvSaveHostOperation): boolean {
        return save_operation_owns_lifecycle(operation)
            && operation.durableTargets.some(save_sheet_displaced);
    }

    /**
     * The worksheet this save captured no longer sits at the index it captured.
     *
     * The session is workbook-scoped, so there is no session pointer to compare
     * against; the operation's own captured name is the identity. An operation
     * with no recorded name is a nameless source (single-sheet CSV), where
     * nothing can move.
     */
    function save_sheet_displaced(identity: WorksheetTarget): boolean {
        if (identity.worksheetId === undefined && identity.sheetName === undefined) {
            return false;
        }
        return sheet_index_identified(identity.worksheetId, identity.sheetName)
            !== identity.sheetIndex;
    }

    /**
     * The operation still holds the save lifecycle, whatever its worksheet is doing.
     *
     * The terminal paths ask this rather than {@link save_operation_is_current}:
     * their job is to *give the lifecycle back*, and refusing to do that because the
     * worksheet moved is precisely how it gets stranded.
     */
    function save_operation_owns_lifecycle(operation: CsvSaveHostOperation): boolean {
        return active_save_operation === operation
            && edit_message_is_current(operation.identity.editSessionId);
    }

    /**
     * `true` while the save may continue; `false` to return quietly.
     *
     * Throws instead of answering when the worksheet moved — see `save_sheet_moved`.
     */
    function save_may_continue(operation: CsvSaveHostOperation): boolean {
        if (save_operation_is_current(operation)) return true;
        if (save_sheet_moved(operation)) {
            throw new Error('The worksheet being saved moved while the save was in flight.');
        }
        return false;
    }

    function save_operation_is_current(operation: CsvSaveHostOperation): boolean {
        return save_operation_owns_lifecycle(operation)
            // The operation's worksheet is a position captured when the save began,
            // and an external reorder mid-save moves the sheet off it. Without
            // this term the operation stays "current" against a stale index:
            // `persist_accepted_save` writes the accepted edits into whatever sheet
            // now sits there and tags them with *that* sheet's name, which is worse
            // than losing them — a later session on the innocent worksheet is
            // offered another sheet's values as its own restored draft.
            //
            // `handle_save` validated the index against the live workbook to start,
            // so this can only fail if the workbook moved underneath, and the save
            // is refused as for any other mid-flight external change.
            && !operation.durableTargets.some(save_sheet_displaced);
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
     * The session covers the whole workbook, so a claim names no worksheet:
     * which sheets carry work is the durable slots' business, and each message
     * or operation names the sheet it is about.
     */
    function try_claim_edit_session(notify = true, claim?: symbol): boolean {
        if (!file_edit_state) return false;
        const phase = file_edit_state.phase;
        if (phase.type === 'owned') {
            if (phase.token !== edit_session_token) return false;
            if (active_edit_session_id === undefined) {
                active_edit_session_id = allocate_edit_session_id(file_key);
            }
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

    interface EditWriteFence {
        readonly release: symbol;
        readonly admittedWrites: Promise<void>;
    }

    /**
     * Stop admitting renderer writes while preserving the authority of every write
     * that crossed the boundary first. Both release and successful save cleanup
     * need this exact transition: clearing the session before the captured tail
     * settles makes an admitted write fail its own CAS validation as stale.
     */
    function fence_edit_session_writes(
        edit_session_id: string,
    ): EditWriteFence | undefined {
        if (!file_edit_state || !edit_message_is_current(edit_session_id)) {
            return undefined;
        }
        active_edit_session_targets.delete(edit_session_id);
        pending_edit_session_targets.delete(edit_session_id);
        const admitted_pending_writes = pending_edit_writes;
        const admitted_append_authority = append_admission_tails.get(
            APPEND_ADMISSION_AUTHORITY_TAIL,
        ) ?? Promise.resolve();
        const release = Symbol(file_key);
        file_edit_state.phase = {
            type: 'releasing',
            release,
            token: edit_session_token,
        };
        notify_edit_state();
        const admittedWrites = (async () => {
            let failure: unknown;
            try {
                await admitted_pending_writes;
            } catch (error) {
                failure = error;
            }
            try {
                await admitted_append_authority;
            } catch (error) {
                failure ??= error;
            }
            // Both tails are now settled, so every publication that crossed the
            // fence has either committed its ledger transition or refused. Only
            // now may release transfer the remaining capabilities to history.
            clear_append_admission_session(edit_session_id);
            if (failure !== undefined) throw failure;
        })();
        return { release, admittedWrites };
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
                    basesValidated: true,
                });
            }
        }
        if (save_lifecycle.state === 'failed') {
            const failed_session_id = save_lifecycle_correlation(save_lifecycle)?.editSessionId;
            if (failed_session_id === edit_session_id) {
                // Only a save that got as far as `persist_accepted_save` leaves anything
                // for the tombstone to undo. The early rejections — base mismatch,
                // removed rows, serialize failure, "still refreshing" — return before
                // `active_save_operation` is even assigned, so the only pending edits on
                // disk are the ones the *user's own* posts made durable. A tombstone
                // there would have `ensure_failed_save_cleanup` strip them by value,
                // silently discarding work the user still has open in the grid: hit Save
                // on an externally-changed file, read the "try again" warning, close the
                // tab, and the edit is gone.
                if ('operation' in save_lifecycle) {
                    const durable_targets = persisted_save_targets.get(
                        save_lifecycle.operation,
                    );
                    if (durable_targets) {
                        file_edit_state.failedSaveTombstone = save_lifecycle.operation;
                    }
                }
                retire_save_lifecycle(edit_session_id, 'failed');
            }
        }

        const fence = fence_edit_session_writes(edit_session_id);
        if (!fence) return Promise.resolve();
        const completion = (async () => {
            try {
                await fence.admittedWrites;
            } catch (error) {
                log_sanitized_failure('Failed to settle admitted CSV edits before release', error);
            } finally {
                if (
                    file_edit_state?.phase.type === 'releasing'
                    && file_edit_state.phase.release === fence.release
                    && active_edit_session_id === edit_session_id
                ) {
                    active_edit_session_id = undefined;
                    file_edit_state.phase = { type: 'free' };
                    notify_edit_state();
                    void ensure_failed_save_cleanup();
                    delete_shared_edit_state_if_unused();
                }
                if (active_edit_release?.release === fence.release) {
                    active_edit_release = undefined;
                }
            }
        })();
        active_edit_release = {
            editSessionId: edit_session_id,
            release: fence.release,
            completion,
        };
        return completion;
    }

    function begin_edit_cleanup(
        edit_session_id: string,
        save_operation?: CsvSaveHostOperation,
        write_fence?: symbol,
    ): symbol | undefined {
        const phase = edit_phase();
        const holds_authority = write_fence === undefined
            ? edit_message_is_current(edit_session_id)
            : active_edit_session_id === edit_session_id
                && phase.type === 'releasing'
                && phase.release === write_fence
                && phase.token === edit_session_token;
        if (
            !file_edit_state
            || !holds_authority
            || (save_operation !== undefined && (
                active_save_operation !== save_operation
                || save_operation.phase !== 'writing'
            ))
        ) return undefined;
        if (save_operation === undefined && active_save_operation) return undefined;
        const operation = Symbol(file_key);
        // A save clears the one worksheet it wrote; a discard ends the session
        // for the whole workbook and clears every live slot.
        const scope: EditCleanupScope = save_operation
            ? { type: 'worksheets', targets: save_operation.durableTargets }
            : { type: 'workbook' };
        active_save_operation = undefined;
        active_edit_session_targets.delete(edit_session_id);
        pending_edit_session_targets.delete(edit_session_id);
        active_edit_session_id = undefined;
        file_edit_state.phase = { type: 'cleanupPending', operation, scope };
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
            : { type: 'uncertain', operation, scope: phase.scope };
        if (success && cleared_snapshot !== undefined) {
            observe_durable_state(cleared_snapshot);
            // `clearedStateRevision` declares every pending edit at or below this
            // revision gone, and `predates_completed_clear` strips the whole leaf
            // on that promise. A sheet-scoped save keeps that promise only when no
            // other worksheet still holds a draft — recording it over a surviving
            // sibling slot (or a parked slot a discard deliberately retained)
            // would strip durable work the clear never touched.
            if (!has_any_pending_edits(
                (cleared_snapshot.state as PerFileState).pendingEdits,
            )) {
                file_edit_state.clearedStateRevision = Math.max(
                    file_edit_state.clearedStateRevision ?? -1,
                    cleared_snapshot.revision,
                );
            }
            retire_save_lifecycle(undefined, 'succeeded');
        }
        notify_edit_state(cleared_snapshot);
        if (success) delete_shared_edit_state_if_unused();
    }

    /**
     * Which durable slot carries `name`, for a panel with no source to ask.
     *
     * `captured_index` is where the worksheet sat when the work began. The slots'
     * own `sheetName` tags are the only record of where it went since, because a
     * disposed panel has no workbook to resolve names against while another window
     * still attached goes on reconciling and committing them.
     *
     * Two slots can be tagged alike — a sheet renamed externally onto a name
     * another slot already recorded — so the name alone does not identify one, and
     * a bare `findIndex` would hand the caller somebody else's draft: clearing work
     * it does not own and leaving its own behind.
     *
     * `owns` breaks that tie on evidence rather than on position. A caller cleaning
     * up after an operation knows which entries are the operation's, and a slot
     * that actually holds them is the operation's slot wherever it now sits.
     * Position is only the tie-break of last resort, because it is precisely what
     * goes stale: the captured index can have been inherited by an unrelated
     * draft that happens to carry the same tag, and preferring it there left the
     * failed save's own entries behind as a phantom draft.
     *
     * Nothing tagged with this name means either slots predating name tagging or a
     * deleted sheet; neither is distinguishable from here, and the captured
     * position is the only answer left — the same one an untagged caller gets.
     */
    function slot_indices_identified(
        slots: PerFileState['pendingEdits'],
        worksheet_id: string | undefined,
        name: string | undefined,
    ): number[] {
        const tagged: number[] = [];
        slots?.forEach((slot, index) => {
            if (!slot) return;
            const matches = slot.worksheetId !== undefined
                ? worksheet_id !== undefined && slot.worksheetId === worksheet_id
                : slot.sheetName === name;
            if (matches) tagged.push(index);
        });
        return tagged;
    }

    function pending_edit_slot_index_identified(
        slots: PerFileState['pendingEdits'],
        worksheet_id: string | undefined,
        name: string | undefined,
        captured_index: number,
    ): number | undefined {
        const tagged = slot_indices_identified(slots, worksheet_id, name);
        if (tagged.length === 0) return undefined;
        return tagged.includes(captured_index) ? captured_index : tagged[0];
    }

    function slot_index_identified(
        slots: PerFileState['pendingEdits'],
        worksheet_id: string | undefined,
        name: string | undefined,
        captured_index: number,
        owns?: (cells: SheetPendingEditCells | undefined) => boolean,
    ): number {
        const tagged = slot_indices_identified(slots, worksheet_id, name);
        if (tagged.length === 0) return captured_index;
        if (tagged.length === 1) return tagged[0];
        if (owns) {
            const owning = tagged.filter((index) => owns(slots?.[index]?.cells));
            if (owning.length === 1) return owning[0];
            // Several slots hold entries matching the operation's, and nothing here
            // can tell which is really its own — the user may have retyped the same
            // value on the other one. Callers that must not guess ask
            // `slot_indices_holding` and act on all of them.
            if (owning.length > 1 && owning.includes(captured_index)) return captured_index;
            if (owning.length > 1) return owning[0];
        }
        return tagged.includes(captured_index) ? captured_index : tagged[0];
    }

    /**
     * Every slot tagged for this operation's worksheet that holds its entries.
     *
     * Where `slot_index_tagged` has to answer with one index, a cleanup does not:
     * the entries it removes are matched by key *and* value, so removing them
     * wherever they appear under this worksheet's name is exactly as targeted as
     * removing them from one slot — and picking a single slot when several match
     * deleted an unrelated draft while leaving the operation's own entries behind
     * as a phantom. Empty when nothing matches, and the single-slot answer
     * otherwise, so the ordinary case is unchanged.
     */
    function slot_indices_holding(
        operation: CsvSaveWorksheetOperation,
        slots: PerFileState['pendingEdits'],
        sheets?: readonly WorksheetIdentityInput[],
    ): number[] {
        const name = operation.sheetName;
        const worksheet_id = operation.worksheetId;
        if (worksheet_id === undefined && name === undefined) return [operation.sheetIndex];
        // Entries first, whether or not the workbook is adopted. Knowing the
        // worksheet's live position tells us where *it* sits, not where its draft
        // does: reconciliation can seat only one of two same-named slots at that
        // index, so resolving by position alone cleaned at most one of them and
        // retired the tombstone with the operation's own entries still durable —
        // a phantom draft that came back next session.
        const holding = slot_indices_identified(slots, worksheet_id, name)
            .filter((index) => holds_operation_entries(slots?.[index]?.cells, operation));
        if (holding.length > 0) return holding;
        if (source) {
            const identities = sheets ?? source.meta().sheets;
            const index = sheet_index_identified(worksheet_id, name, identities);
            return index === undefined ? [] : [index];
        }
        return [slot_index_identified(
            slots,
            worksheet_id,
            name,
            operation.sheetIndex,
        )];
    }

    /**
     * Where this operation's worksheet sits in durable state *now*.
     *
     * `operation.sheetIndex` is a position captured when the save began, but the
     * durable leaf is reconciled by name on every write, so a workbook reordered
     * since then has moved the slot out from under it. Asking by name keeps a
     * tombstone's cleanup pointed at its own edits — and returns `undefined` when
     * the worksheet was deleted, which is "nothing to clean" rather than a
     * positional guess at somebody else's slot.
     *
     * An operation with no recorded name is a nameless source (or a legacy shape),
     * whose slot is only ever reattached by position anyway.
     *
     * A disposed panel is the awkward case: it has no source to name sheets from,
     * but another window may still be attached, reordering the workbook and writing
     * name-reconciled slots that this cleanup then reads. Falling back to the
     * captured position there cleared whichever draft had inherited that index and
     * left the failed save's own entries behind — the tombstone retired regardless,
     * so the phantom survived into the next session. `slots` is the durable array
     * this cleanup is about to modify; see {@link slot_index_tagged}.
     */
    function operation_sheet_index(
        operation: CsvSaveWorksheetOperation,
        sheets?: readonly WorksheetIdentityInput[],
        slots?: PerFileState['pendingEdits'],
    ): number | undefined {
        const name = operation.sheetName;
        const worksheet_id = operation.worksheetId;
        if (worksheet_id === undefined && name === undefined) return operation.sheetIndex;
        if (source) return sheet_index_identified(worksheet_id, name, sheets);
        // Its own entries identify the operation's slot among duplicate legacy tags
        // better than a captured position does.
        return slot_index_identified(
            slots,
            worksheet_id,
            name,
            operation.sheetIndex,
            (cells) => holds_operation_entries(cells, operation),
        );
    }

    /**
     * Does this slot hold any of `operation`'s own entries, unchanged?
     *
     * The same key/value test `strip_operation_owned_pending_edits` uses to decide
     * what to remove, asked as a question instead — so "which slot would this
     * cleanup actually strip something from" is answered before choosing one.
     */
    function holds_operation_entries(
        cells: SheetPendingEditCells | undefined,
        operation: CsvSaveWorksheetOperation,
    ): boolean {
        if (!cells) return false;
        return Object.entries(cells).some(([key, pending]) => {
            const owned = operation.dirtyEdits[key];
            if (!owned) return false;
            // Full durable identity, runs included (a formatting-only change
            // is a different edit); legacy string entries carry no runs, so
            // equal value is their whole identity.
            return typeof pending === 'string'
                ? pending === owned.value
                : dirty_entries_equal(pending, owned);
        });
    }

    function strip_operation_owned_pending_edits(
        pending_edits: SheetPendingEditCells | undefined,
        operation: CsvSaveWorksheetOperation,
    ): SheetPendingEditCells | undefined {
        if (!pending_edits) return undefined;
        const retained = Object.fromEntries(
            Object.entries(pending_edits).filter(([key, pending]) => {
                const owned = operation.dirtyEdits[key];
                if (!owned) return true;
                // Runs are part of the match: a pending entry whose formatting
                // differs from what the operation carried is a newer
                // formatting-only edit and must survive the strip.
                return typeof pending === 'string'
                    ? pending !== owned.value
                    : !dirty_entries_equal(pending, owned);
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
        pending_edits: SheetPendingEditCells | undefined,
        operation: CsvSaveWorksheetOperation,
    ): boolean {
        const owned = Object.keys(operation.dirtyEdits).length;
        if (owned === 0 || !pending_edits) return false;
        if (Object.keys(pending_edits).length !== owned) return false;
        return strip_operation_owned_pending_edits(pending_edits, operation) === undefined;
    }

    function pending_changes_echo_operation(
        slot: WorksheetPendingEdits | undefined,
        operation: CsvSaveWorksheetOperation,
    ): boolean {
        if (!slot) return false;
        const owned_cell_count = Object.keys(operation.dirtyEdits).length;
        const cells_match = owned_cell_count === 0
            ? Object.keys(slot.cells).length === 0
            : post_echoes_operation(slot.cells, operation);
        if (!cells_match) return false;
        const structural = operation.structuralChanges;
        return JSON.stringify({
            formatTemplates: slot.formatTemplates ?? [],
            appendedRows: slot.appendedRows ?? [],
            tailRemovals: slot.tailRemovals ?? [],
            ...(slot.appendBasis === undefined ? {} : { appendBasis: slot.appendBasis }),
            conflicts: slot.conflicts ?? [],
        }) === JSON.stringify(structural ?? {
            formatTemplates: [],
            appendedRows: [],
            tailRemovals: [],
            conflicts: [],
        });
    }

    /**
     * `scope` names the worksheet whose cells these are, when the caller knows.
     * A save lifecycle and a tombstone each belong to one worksheet, so their
     * strips apply only to that sheet's cells: matching by key and value alone
     * would let a coincidentally identical entry on a *different* sheet be
     * stripped by an operation that never touched it. Unscoped calls keep the
     * strip unconditional, which is right when the cells are already known to be
     * the operation's own sheet's.
     */
    function pending_edits_for_current_session(
        pending_edits: SheetPendingEditCells | undefined,
        scope?: {
            sheetIndex: number;
            sheets?: readonly WorksheetIdentityInput[];
            slots?: PerFileState['pendingEdits'];
        },
    ): SheetPendingEditCells | undefined {
        const applies = (worksheet: CsvSaveWorksheetOperation) => !scope
            || operation_sheet_index(worksheet, scope.sheets, scope.slots)
                === scope.sheetIndex;
        let projected = pending_edits;
        if (save_lifecycle.state !== 'idle' && 'operation' in save_lifecycle) {
            if (
                save_lifecycle.state !== 'succeeded'
                && save_lifecycle.operation.editSessionId === active_edit_session_id
            ) return projected;
            for (const worksheet of save_lifecycle.operation.worksheets) {
                if (!applies(worksheet)) continue;
                projected = strip_operation_owned_pending_edits(projected, worksheet);
            }
        }
        const tombstone = file_edit_state?.failedSaveTombstone;
        if (tombstone && tombstone.editSessionId !== active_edit_session_id) {
            for (const worksheet of tombstone.worksheets) {
                if (!applies(worksheet)) continue;
                projected = strip_operation_owned_pending_edits(projected, worksheet);
            }
        }
        return projected;
    }

    /**
     * Apply the session projection across the whole leaf.
     *
     * The session covers the workbook, so every slot whose name resolves at its
     * own index — or that carries no name at all, the single-sheet legacy shape —
     * is this session's work to show. What is dropped is a *parked* slot: one
     * tagged for a worksheet the workbook no longer has, or displaced from the
     * index its name now resolves to. Those drafts stay durable and reappear
     * when their worksheet does; projecting them into whatever sheet holds their
     * old position is the cross-worksheet corruption the name tags exist to
     * prevent.
     */
    function leaf_pending_edits_for_current_session(
        pending_edits: PerFileState['pendingEdits'],
        sheets: readonly WorksheetIdentityInput[] = source?.meta().sheets ?? [],
    ): PerFileState['pendingEdits'] {
        if (!pending_edits) return undefined;
        const live_identity = (index: number) => {
            const sheet = sheets[index];
            return sheet === undefined ? undefined : worksheet_identity(sheet);
        };
        let projected_slots: (WorksheetPendingEdits | undefined)[] | undefined;
        for (let index = 0; index < pending_edits.length; index += 1) {
            const slot = pending_edits[index];
            if (!slot) {
                projected_slots?.push(undefined);
                continue;
            }
            // Named as well as indexed, so a displaced slot cannot be handed to
            // the sheet at its position. `pending_edits_for_sheet` has always
            // refused that; it just needs to be told which sheet this is.
            const identity = live_identity(index);
            const cells = pending_edits_for_sheet(
                pending_edits,
                index,
                identity?.name,
                identity?.worksheetId,
            );
            const projected = cells
                ? pending_edits_for_current_session(cells, {
                    sheetIndex: index,
                    sheets,
                    slots: pending_edits,
                })
                : undefined;
            if (projected === slot.cells) {
                projected_slots?.push(slot);
                continue;
            }
            projected_slots ??= pending_edits.slice(0, index);
            const has_structural = (slot.appendedRows?.length ?? 0) > 0
                || (slot.tailRemovals?.length ?? 0) > 0;
            projected_slots.push(projected || has_structural
                ? { ...slot, cells: projected ?? {} }
                : undefined);
        }
        // Preserve identity when nothing changed, so callers can keep using
        // reference equality to detect a no-op projection.
        if (!projected_slots) return pending_edits;
        while (
            projected_slots.length > 0
            && projected_slots[projected_slots.length - 1] === undefined
        ) projected_slots.pop();
        return projected_slots.some(Boolean) ? projected_slots : undefined;
    }

    function ensure_failed_save_cleanup(): Promise<void> {
        if (!file_edit_state?.failedSaveTombstone) return Promise.resolve();
        if (file_edit_state.failedSaveCleanup) return file_edit_state.failedSaveCleanup;
        const operation = file_edit_state.failedSaveTombstone;
        let cleanup!: Promise<void>;
        cleanup = (async () => {
            try {
                const committed = await update_file_state((current, sheets) => {
                    // Scoped to the operation's own sheet: another worksheet's
                    // slot is unrelated work this cleanup must not touch. Resolved
                    // by name, because `update_file_state` has already reconciled
                    // `current`'s slots against the adopted workbook.
                    // Every slot holding this operation's entries, not one guessed
                    // between indistinguishable candidates: the strip matches key
                    // *and* value, so it removes only what this save wrote.
                    let next = current.pendingEdits;
                    let changed = false;
                    for (const worksheet of operation.worksheets) {
                        const targets = slot_indices_holding(worksheet, next, sheets);
                        for (const sheet_index of targets) {
                            const slot = next?.[sheet_index];
                            const pending_edits = strip_operation_owned_pending_edits(
                                slot?.cells,
                                worksheet,
                            );
                            if (pending_edits === slot?.cells) continue;
                            changed = true;
                            next = with_pending_edits_for_sheet(
                                next,
                                sheet_index,
                                pending_edits,
                                slot?.sheetName,
                                slot?.worksheetId,
                            );
                        }
                    }
                    if (!changed) return current;
                    if (next) return { ...current, pendingEdits: next };
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
        // The workbook being adopted, when that is not yet the installed `source`:
        // adoption projects *before* `source = next`, so a name resolved against
        // the module-level source there is answered by the outgoing workbook or,
        // on a first open, by nothing at all.
        sheets?: readonly WorksheetIdentityInput[],
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
        const owns_session = owns_edit_session();
        // A claim is only worth making when some slot describes a worksheet this
        // workbook actually has. Already-owned projections never need this scan.
        const rehydratable = !owns_session && allow_claim && editing_supported
            && has_rehydratable_pending_edits(state.pendingEdits, sheets);
        const represents_session = !predates_completed_clear
            && !edit_cleanup_blocked()
            && editing_supported
            && (
                owns_session
                || (rehydratable && try_claim_edit_session(false))
            );
        // A rehydration claim acquires the session with no grant round-trip,
        // so the grant-time ledger seeding never runs for it. Seed here, once,
        // at the moment the claim succeeds — publications of the restored
        // structural rows are otherwise refused as unsettled row authority.
        if (represents_session && !owns_session && active_edit_session_id !== undefined) {
            seed_durable_append_admissions(
                active_edit_session_id,
                state.pendingEdits,
                sheets ?? source?.meta().sheets ?? [],
            );
        }
        if (represents_session) {
            const pending_edits = leaf_pending_edits_for_current_session(
                state.pendingEdits,
                sheets,
            );
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
        // `try_claim_edit_session` refused a session nobody holds.
        if (
            allow_claim
            && editing_supported
            && !!file_edit_state
            && !predates_completed_clear
            // Slots naming no live worksheet decline the claim deliberately. The
            // drafts are not dropped either — they stay durable, and reappear the
            // moment the workbook has those names again.
            && rehydratable
            && edit_phase().type === 'free'
        ) {
            console.error('Dropped durable CSV pending edits with no panel holding the session');
        }
        const { pendingEdits: _drop, ...rest } = state;
        return { revision: snapshot.revision, state: rest };
    }

    function validate_restored_pending_edits(
        src: DataSource,
        pending_edits: SheetPendingEditCells,
        sheet_index: number,
    ): { dirtyEdits: CsvDirtyMap; rejection: CsvSaveRejection } | undefined {
        const dirty_edits: CsvDirtyMap = Object.fromEntries(
            Object.entries(pending_edits).filter((entry): entry is [string, {
                value: string;
                base: string;
            }] => typeof entry[1] !== 'string'),
        );
        if (Object.keys(dirty_edits).length === 0) return undefined;

        const source_row_count = src.meta().sheets[sheet_index]?.sourceRowCount ?? 0;
        // The same harvest the save path uses, so the two cannot disagree about a
        // base. It projects source rows before reading, which is identity for a CSV
        // and off by the promoted header row for an Excel sheet — reading source
        // indices directly here made every restored edit under a promoted header
        // look conflicted.
        const observed_bases = harvest_source_bases(
            src,
            sheet_index,
            Object.keys(dirty_edits),
        );

        const validation = validate_dirty_bases(
            dirty_edits,
            source_row_count,
            (source_row, col) => observed_bases.texts.get(`${source_row}:${col}`),
            (source_row, col) => observed_bases.rich.get(`${source_row}:${col}`),
            (source_row, col) => observed_bases.links.get(`${source_row}:${col}`),
        );
        if (validation.type === 'valid') return undefined;
        return {
            dirtyEdits: dirty_edits,
            rejection: base_validation_save_rejection(validation, 0),
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
        // `sheets` is the list `current` was normalized against, and an updater that
        // resolves a worksheet must use it rather than reading `source` again: the
        // list is captured before the `read_file_state` await below, so a reload
        // landing during that await would leave the two describing different
        // workbook orders — and a cleanup aimed at one sheet would clear another's.
        //
        // No ordering was found that reaches it: the authority queue serializes a
        // reload behind an in-flight state read, so `source` cannot change across
        // this await today. Threaded anyway rather than relied upon, because that is
        // a property of another module and the failure it would cause here is
        // another worksheet's unsaved work deleted with nothing to show for it.
        updater: (
            current: PerFileState,
            sheets: readonly WorksheetIdentityInput[],
        ) => PerFileState,
        sheet_identities: readonly WorksheetIdentity[] = source?.meta().sheets ?? [],
        validate?: () => boolean,
        write_basis: FileStateWriteBasis | null = {
            expectedAuthorityRevision: source_authority.authorityRevision,
        },
    ): Promise<FileStateSnapshot | undefined> {
        let snapshot = await read_file_state(false);
        for (;;) {
            if (validate && !validate()) return undefined;
            const current = normalize_host_state(snapshot.state, sheet_identities);
            const next = updater(current, sheet_identities);
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
        const sheets = source.meta().sheets;
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
                    sheets,
                ),
            };
        }
        const basis = layout_basis;
        const incoming = complete_normalized_per_file_state(message.state, sheets);
        const patch = derive_layout_state_patch(basis.state, incoming);
        const next_basis = complete_normalized_per_file_state(
            apply_layout_state_patch(basis.state, patch),
            sheets,
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
        }, source.meta().sheets, () => layout_write_is_current(message, expected_authority), write_basis);
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
        updater: (
            current: PerFileState,
            sheets: readonly SheetMeta[],
        ) => PerFileState,
        write_currency?: {
            readonly expectedAuthorityRevision: number;
            readonly isCurrent: () => boolean;
        },
    ): Promise<EditStateWriteResult> {
        const is_current = () => {
            if (
                active_edit_session_id !== edit_session_id
                || !pending_edit_admissions.has(admission)
                || (write_currency !== undefined && !write_currency.isCurrent())
            ) return false;
            const phase = edit_phase();
            return (phase.type === 'owned' || phase.type === 'releasing')
                && phase.token === edit_session_token;
        };
        const expected_authority_revision = write_currency?.expectedAuthorityRevision
            ?? source_authority.authorityRevision;
        let snapshot = await read_file_state(false);
        for (;;) {
            if (!is_current()) return { type: 'aborted' };
            const sheets = source?.meta().sheets ?? [];
            const current = normalize_host_state(snapshot.state, sheets);
            const next = updater(current, sheets);
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
                sheets,
            );
            const transforms = sheets.map((sheet, index) => {
                const state = sanitize_transform_state(
                    durable.transforms?.[index],
                    sheet.columnCount,
                    transform_schema_for_sheet(sheet),
                    sheet.sourceRowCount,
                );
                // The compare window's changed-rows filter is session state and is
                // stripped at the durable write, so it is absent from what was just
                // read back. Reconciling against that alone un-installed the filter
                // one generation after it installed — the commit that persisted it
                // is what triggers this very reconciliation — so the rows sprang
                // back and the toggle appeared to do nothing. Carried over from
                // what this core actually has installed, which is the live answer.
                if (
                    reconciliation_core.installed_transform_state(index)
                        ?.onlyChangedRows !== true
                ) return state;
                return {
                    ...(state ?? {
                        sort: [],
                        filters: [],
                        schema: transform_schema_for_sheet(sheet),
                    }),
                    onlyChangedRows: true as const,
                };
            });
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
                sheets,
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
            // Session state stops at the durable boundary here too; see the
            // matching strip in `persist_transform_commit`.
            const { onlyChangedRows: _retained_session, ...retained } = error.retainedState;
            transforms[error.sheetIndex] = transform_has_entries(retained)
                ? {
                    ...retained,
                    sort: retained.sort.map((key) => ({ ...key })),
                    filters: retained.filters.map(clone_filter_entry),
                    ...(retained.hiddenRows
                        ? { hiddenRows: [...retained.hiddenRows] }
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
            // `onlyChangedRows` is compare-session state and stops here. The
            // renderer and the core both need it — it is how the toggle knows
            // it is on — but persisted it would reopen a plain window filtered
            // by a comparison it no longer has, with no control to clear it.
            // This durable write is the one boundary it must not cross.
            const { onlyChangedRows: _session_only, ...durable } = state;
            transforms[message.sheetIndex] = transform_has_entries(durable)
                ? {
                    ...durable,
                    sort: durable.sort.map((key) => ({ ...key })),
                    filters: durable.filters.map(clone_filter_entry),
                    ...(durable.hiddenRows ? { hiddenRows: [...durable.hiddenRows] } : {}),
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

    async function build_source(
        {
            bypassFileSizeLimit = false,
            includeCompareOriginal = true,
            load: load_request,
        }: {
            bypassFileSizeLimit?: boolean;
            includeCompareOriginal?: boolean;
            /**
             * The load this build serves, so a superseded alignment can stop.
             *
             * Required, not optional: omitting it would silently opt that build
             * out of supersede cancellation, which is the failure this
             * parameter exists to prevent. Every caller has a request in hand.
             */
            load: Pick<PanelLoadRequest, 'seq' | 'refreshEvent'>;
        },
    ): Promise<SourceCandidate> {
        const state = (await read_file_state()).state as PerFileState;
        const stat = await host.fs.stat(uri);
        const max_mib = host.config.max_file_size_mib();
        if (!bypassFileSizeLimit) assert_safe_file_size(stat.size, max_mib);
        const fingerprint = `${stat.mtime}:${stat.size}`;
        const use_file_backed_source = uri.scheme.toLowerCase() === 'file'
            && profile.build_file_source !== undefined
            && (profile.prefer_file_source || stat.size > MAX_WHOLE_FILE_READ_BYTES);
        let observation: PhysicalSourceObservation;
        let raw: Uint8Array | undefined;
        let file_backed_source: DataSource | undefined;
        if (use_file_backed_source) {
            let owned_source: DataSource | undefined;
            try {
                const built = await profile.build_file_source!(
                    file_path,
                    state,
                    {
                        ...(load_all_csv_rows ? { loadAllRows: true } : {}),
                        isCancelled: () => !load_is_current(
                            load_request.seq,
                            load_request.refreshEvent,
                        ),
                    },
                );
                owned_source = built.source;
                if (`${built.mtime}:${built.size}` !== fingerprint) {
                    throw new Error('The file changed while it was being opened.');
                }
                file_backed_source = owned_source;
                owned_source = undefined;
                observation = {
                    fingerprint,
                    digest: built.digest,
                    verification: 'bracketedDigest',
                };
            } finally {
                owned_source?.close();
            }
        } else {
            const read_raw_main = await host.fs.read_file(uri);
            if (!bypassFileSizeLimit) {
                assert_safe_file_size(read_raw_main.byteLength, max_mib);
            }
            observation = {
                fingerprint,
                // Digests what was *read*, not what is parsed below: substituting
                // smudged bytes must not make the panel look like it has already
                // seen a file it has not, or the next real change is missed.
                digest: content_digest(read_raw_main),
            };
            // Before the parser, which is the whole point: a `.csv` pointer parses
            // into a convincing three-row grid of LFS metadata and an `.xlsx`
            // pointer fails somewhere inside the ZIP reader. Neither tells the user
            // the bytes were never fetched, so a pointer never reaches a profile.
            const pointer = parse_git_lfs_pointer(read_raw_main);
            raw = read_raw_main;
            if (pointer && resolved_lfs_main?.oid === pointer.oid) {
                // Already fetched for this panel, so the pointer is not news. Kept
                // in memory because this side may be a `git:` revision, whose read
                // returns the committed pointer blob however often it is retried.
                // Matched on oid so a refresh reading a different revision is not
                // served another revision's bytes.
                raw = resolved_lfs_main.content;
                if (unresolved_lfs?.side === 'file') unresolved_lfs = undefined;
            } else if (pointer) {
                note_unresolved_lfs('file', pointer);
                // The comparison is moot when the file itself has no content: there
                // is nothing to diff against, and fetching the original would spend
                // a download on an alignment against an empty grid.
                return new SourceCandidate(new UnresolvedLfsDataSource(), observation);
            }
        }
        // Only this side's record is cleared. A blanket clear here would run
        // *before* the original side is read, so it would erase the failure
        // `note_unresolved_lfs` is about to carry over — the compare original's
        // record is written later in this same build, and clearing it is that
        // path's own business.
        if (unresolved_lfs?.side === 'file') unresolved_lfs = undefined;
        // Captured before any await, so it names the receiver this build began
        // for rather than whichever one is current when progress is reported.
        const receiver_epoch = session.current_receiver_epoch;
        // The original side builds concurrently with the modified parse; both
        // are independent reads of already-committed bytes.
        const original_promise = includeCompareOriginal
            ? build_compare_original(state)
            : Promise.resolve(undefined);
        let modified: DataSource;
        try {
            modified = file_backed_source ?? await profile.build_source(
                raw!, file_path, state,
                load_all_csv_rows ? { loadAllRows: true } : undefined,
            );
        } catch (error) {
            void original_promise
                .then((original) => original?.source.close())
                .catch(() => {});
            throw error;
        }
        const original = await original_promise;
        let adopted = modified;
        let comparison_observation: Readonly<PhysicalSourceObservation> | undefined;
        if (original) {
            try {
                // Aligned before the source is built: comparing row N to row N
                // reports an inserted or moved row as a screenful of changed
                // cells, and the alignment fixes the row counts meta() reports,
                // so it cannot be deferred until after construction.
                adopted = new CompareDataSource(
                    modified,
                    original.source,
                    await align_workbook(modified, original.source, {
                        // Superseded counts as cancelled. A refresh replaces the
                        // load this alignment is for, and the original side has a
                        // watcher of its own, so two alignments can be in flight
                        // over the same window; without this the outdated one runs
                        // to completion on a large file for a result already thrown
                        // away.
                        isCancelled: () => compare_alignment_cancelled
                            || disposed
                            || !load_is_current(
                                load_request.seq, load_request.refreshEvent),
                        onProgress: (scannedRows, totalRows) => {
                            // Superseded is checked here too, not left to
                            // `isCancelled`: the aligner reports progress at the
                            // top of a checkpoint and tests for cancellation at
                            // the bottom, so an alignment superseded between
                            // checkpoints gets one more report out first — into
                            // the bar its replacement is now driving, which is
                            // how a bar moves backwards. Narrow enough that no
                            // test pins the interleaving; the cancel below is
                            // what the regression test covers.
                            if (!load_is_current(
                                load_request.seq, load_request.refreshEvent)) return;
                            // Epoch-gated so a webview that reloaded mid-align is
                            // not driven by the bar of the load it replaced.
                            // Defensive, and matching what every other epoch-aware
                            // post here does: no test drives it, because a reload
                            // supersedes the load as well and the cancel above
                            // wins the race in practice.
                            void post_to_receiver({
                                type: 'compareProgress',
                                scannedRows,
                                totalRows,
                            }, receiver_epoch);
                        },
                    }),
                );
                comparison_observation = original.observation;
            } catch (error) {
                try {
                    original.source.close();
                } catch (close_error) {
                    log_sanitized_failure(
                        'Failed to close unavailable comparison source',
                        close_error,
                    );
                }
                // A cancel is either the user's own decision — the window is on
                // its way out — or a refresh superseding this load, and neither
                // is a failure to report back. Nothing is adopted on this path
                // either way, so the modified side has no other owner and is
                // closed here, unlike an alignment *failure*, where it survives
                // as the plain-file fallback.
                if (error instanceof AlignmentCancelledError) {
                    try {
                        modified.close();
                    } catch (close_error) {
                        log_sanitized_failure(
                            'Failed to close a cancelled comparison source',
                            close_error,
                        );
                    }
                    throw error;
                }
                warn_compare_unavailable(error);
            }
        }
        return new SourceCandidate(adopted, {
            ...observation,
            ...(comparison_observation
                ? {
                    comparisonFingerprint: comparison_observation.fingerprint,
                    comparisonDigest: comparison_observation.digest,
                }
                : {}),
        });
    }

    /**
     * Build the git original through the same profile and per-file state as
     * the modified side, so both sides share projection policy (CSV row caps,
     * Excel header overrides/hidden rows) and differ only in bytes. The
     * original must never block the file itself: any failure — including
     * exceeding the configured size limit — degrades to a plain open with a
     * one-time warning.
     */
    async function build_compare_original(
        state: PerFileState,
    ): Promise<{
        readonly source: DataSource;
        readonly observation: Readonly<PhysicalSourceObservation>;
    } | undefined> {
        if (!compare_original_uri) return undefined;
        try {
            const max_mib = host.config.max_file_size_mib();
            // Stat before reading so an oversized original degrades without
            // pulling its full bytes into memory first.
            const stat = await host.fs.stat(compare_original_uri);
            assert_safe_file_size(stat.size, max_mib);
            const read_raw = await host.fs.read_file(compare_original_uri);
            assert_safe_file_size(read_raw.byteLength, max_mib);
            const original_path = compare_original_uri.fsPath;
            // The pointer case is not an edge case on this side: a `git:` read
            // returns the *committed* blob, and for an LFS-tracked file that
            // blob is the pointer whether or not the working tree was smudged.
            // So every Git table diff of an LFS file arrives here as a pointer,
            // and without this the diff would compare real rows against three
            // lines of metadata and call almost everything changed.
            const original_pointer = parse_git_lfs_pointer(read_raw);
            let original_raw = read_raw;
            if (!original_pointer && unresolved_lfs?.side === 'original') {
                unresolved_lfs = undefined;
            }
            if (original_pointer) {
                // A resolve earlier in this panel's life already fetched it.
                // Matched on oid rather than trusted blindly: a refresh may be
                // reading a different revision than the one that was resolved.
                if (resolved_lfs_original?.oid === original_pointer.oid) {
                    original_raw = resolved_lfs_original.content;
                    if (unresolved_lfs?.side === 'original') unresolved_lfs = undefined;
                } else {
                    note_unresolved_lfs('original', original_pointer);
                    // Undefined rather than a placeholder source: the modified
                    // side is real and readable, so the panel shows the file
                    // plainly and only the diff is missing — exactly the
                    // existing degrade-to-plain-open contract, minus the
                    // warning, because the banner says it better.
                    return undefined;
                }
            }
            // Mirror the modified side's row cap: uncapping only one side
            // would report every row beyond the other's cap as added/deleted.
            // The window is attached for the modified file, so its profile
            // parses the modified format. Feeding the original's bytes to it
            // is right whenever the two share an extension — and that profile
            // may be host-supplied (preview, git compare), so it is kept — but
            // across formats it fed CSV bytes to the XLSX parser, and between
            // .csv and .tsv split one side on the wrong delimiter. Those are
            // exactly the pairings the Compare dialog offers.
            const original_profile = same_extension(original_path, file_path)
                ? profile
                : profile_for(original_path, host.config);
            return {
                source: await original_profile.build_source(
                    original_raw,
                    original_path,
                    state,
                    load_all_csv_rows ? { loadAllRows: true } : undefined,
                ),
                observation: {
                    fingerprint: `${stat.mtime}:${stat.size}`,
                    // Digested from what was *read*, not from what was parsed.
                    // The two differ only for a resolved LFS original, where
                    // `original_raw` holds smudged bytes that are nowhere on
                    // the other end of this URI: `built_source_currency`
                    // re-reads it and digests what it finds, so digesting the
                    // substitute here would make every resolved comparison
                    // permanently stale and the resolve itself never land.
                    digest: content_digest(read_raw),
                },
            };
        } catch (error) {
            warn_compare_unavailable(error);
            return undefined;
        }
    }

    /** The snapshot's compare payload — present exactly when the adopted source
     *  is a live compare session (a degraded compare open carries nothing). */
    function compare_configuration(
        adopted: DataSource | undefined,
    ): { gitCompare: WorkbookSnapshotCompare } | Record<string, never> {
        if (!(adopted instanceof CompareDataSource)) return {};
        return {
            gitCompare: {
                pairings: adopted.pairings,
                sheetStatuses: adopted.sheetStatuses,
                changedColumnNames: adopted.changedColumnNames,
                ...(compare_original_uri
                    ? {
                        sides: {
                            originalPath: compare_original_uri.fsPath,
                            modifiedPath: file_path,
                        },
                    }
                    : {}),
                counts: adopted.change_counts(),
                degraded: adopted.degraded,
                moveSearchTruncated: adopted.moveSearchTruncated,
            },
        };
    }

    /**
     * Every unfetched pointer this panel would have to download to show what it
     * was asked to show, starting from the one the banner names.
     *
     * Only one side can ever need discovering, and it is always the original.
     * The sides are read in order: the original is reached only once the
     * modified side has parsed, so a banner naming the *original* already
     * proves the modified side is real bytes, and a banner naming the *file*
     * means the build returned before the original was read at all. So the
     * second pointer is looked for in exactly that one case.
     *
     * Discovering it here rather than after a rebuild is the whole point: a
     * comparison's second pointer used to become visible only once the panel
     * was rebuilt, and a rebuild delivers a snapshot — so the window flashed
     * through an undiffed grid carrying a second Download button before the
     * comparison arrived.
     *
     * A side whose bytes are already cached is not a target — its oid is
     * matched, so a refresh that moved to a different revision still reports
     * the pointer it actually found. Neither is an unreadable side: there is
     * nothing to fetch for a URI that cannot be read, and the ordinary load
     * path is what reports that.
     */
    async function lfs_resolve_targets(
        named: UnresolvedLfsObject,
    ): Promise<readonly UnresolvedLfsObject[]> {
        if (named.side !== 'file' || !compare_original_uri) return [named];
        try {
            // Sized before it is read. This side may be the real table — a
            // hundred megabytes of committed `.xlsx` — and the only question
            // asked of it is whether it is a pointer, which the spec caps at a
            // kilobyte. Pulling the whole blob into memory to answer that is
            // exactly the cost the ordinary load path already pays once; paying
            // it a second time here is avoidable.
            const stat = await host.fs.stat(compare_original_uri);
            if (stat.size > MAX_POINTER_BYTES) return [named];
            const pointer = parse_git_lfs_pointer(
                await host.fs.read_file(compare_original_uri),
            );
            if (!pointer || resolved_lfs_original?.oid === pointer.oid) return [named];
            // `resolvable` is true by construction: the handler established
            // that the host has a git-lfs port before asking for targets.
            return [named, {
                side: 'original',
                oid: pointer.oid,
                size: pointer.size,
                resolvable: true,
            }];
        } catch {
            return [named];
        }
    }

    /**
     * Whether `target`'s side is *still* an unresolved pointer, read from the
     * host rather than inferred from a refresh's return value.
     *
     * Needed because a refresh reports `false` for a superseded load as
     * readily as for a failed one, and a resolve reliably races the file
     * watcher it just woke. A side already smudged into memory answers from
     * that cache; only an unresolved working-tree file is worth a read.
     */
    async function file_is_still_a_pointer(
        target: UnresolvedLfsObject,
    ): Promise<boolean> {
        // Neither side has disk state to consult once it has been smudged: the
        // bytes live in memory, and re-reading a `git:` revision returns the
        // committed pointer forever. So the cache is the answer, and without
        // consulting it a superseding watcher refresh makes the caller discard
        // bytes already fetched and download the same object again.
        if (target.side === 'original') {
            return resolved_lfs_original?.oid !== target.oid;
        }
        if (resolved_lfs_main?.oid === target.oid) return false;
        try {
            return parse_git_lfs_pointer(await host.fs.read_file(uri)) !== undefined;
        } catch {
            // Unreadable is not resolved; keep the banner and the button.
            return true;
        }
    }

    /** The snapshot's LFS payload — present exactly while a side is an
     *  unfetched pointer. Spread beside `compare_configuration` so both
     *  controller-owned snapshot facts are projected the same way. */
    function lfs_configuration(): { unresolvedLfs: UnresolvedLfsObject } | Record<string, never> {
        return unresolved_lfs ? { unresolvedLfs: unresolved_lfs } : {};
    }

    function warn_compare_unavailable(error: unknown): void {
        if (compare_unavailable_warned) return;
        compare_unavailable_warned = true;
        log_sanitized_failure('Table compare unavailable', error);
        show_owner_warning(
            'Table compare is unavailable: the original version could not be loaded. '
            + 'Showing the file without change highlighting.',
        );
    }

    async function build_source_with_file_size_decision(
        request: PanelLoadRequest,
        initial: boolean,
        include_compare_original = true,
    ): Promise<
        | { type: 'candidate'; candidate: SourceCandidate }
        | { type: 'stopped' }
        | { type: 'stale' }
    > {
        try {
            return {
                type: 'candidate',
                candidate: await build_source({
                    bypassFileSizeLimit: request.bypassFileSizeLimit,
                    includeCompareOriginal: include_compare_original,
                    load: request,
                }),
            };
        } catch (error) {
            if (!(error instanceof FileSizeLimitExceededError)) throw error;
            if (!load_is_current(request.seq, request.refreshEvent)) return { type: 'stale' };
            const choice = await host.ui.show_file_size_limit_dialog({
                actualBytes: error.actualBytes,
                limitBytes: error.limitBytes,
            });
            if (!load_is_current(request.seq, request.refreshEvent)) return { type: 'stale' };
            if (choice === 'openAnyway') {
                // A stability/authority retry is still the same user-directed
                // open. Carry its admission with the request so a deterministic
                // downstream error cannot reopen this modal three more times.
                request.bypassFileSizeLimit = true;
                return {
                    type: 'candidate',
                    candidate: await build_source({
                        bypassFileSizeLimit: true,
                        includeCompareOriginal: include_compare_original,
                        load: request,
                    }),
                };
            }
            if (choice === 'configure') {
                await host.ui.open_setting('maxFileSizeMiB');
                if (!load_is_current(request.seq, request.refreshEvent)) return { type: 'stale' };
            }
            if (initial) await options.requestClose?.();
            return { type: 'stopped' };
        }
    }

    async function built_source_currency(
        seq: number,
        candidate: SourceCandidate,
        refresh_event?: FileRefreshEvent,
    ): Promise<'current' | 'stale' | 'comparison-stale'> {
        if (!load_is_current(seq, refresh_event)) return 'stale';
        const { fingerprint, digest } = candidate.observation;
        const stat = await host.fs.stat(uri);
        if (
            !load_is_current(seq, refresh_event)
            || `${stat.mtime}:${stat.size}` !== fingerprint
        ) {
            return 'stale';
        }
        if (candidate.observation.verification !== 'bracketedDigest') {
            const raw = await host.fs.read_file(uri);
            const verified_stat = await host.fs.stat(uri);
            if (
                !load_is_current(seq, refresh_event)
                || `${verified_stat.mtime}:${verified_stat.size}` !== fingerprint
                || content_digest(raw) !== digest
            ) {
                return 'stale';
            }
        }
        const comparison_fingerprint = candidate.observation.comparisonFingerprint;
        const comparison_digest = candidate.observation.comparisonDigest;
        if (!compare_original_uri || !comparison_fingerprint || !comparison_digest) {
            return 'current';
        }
        try {
            const comparison_stat = await host.fs.stat(compare_original_uri);
            if (`${comparison_stat.mtime}:${comparison_stat.size}` !== comparison_fingerprint) {
                return 'comparison-stale';
            }
            const comparison_raw = await host.fs.read_file(compare_original_uri);
            const verified_comparison_stat = await host.fs.stat(compare_original_uri);
            if (!load_is_current(seq, refresh_event)) return 'stale';
            return `${verified_comparison_stat.mtime}:${verified_comparison_stat.size}`
                === comparison_fingerprint
                && content_digest(comparison_raw) === comparison_digest
                ? 'current'
                : 'comparison-stale';
        } catch {
            // The original is optional. Reject this candidate so a rebuild can
            // either recover the comparison or use its existing plain-view fallback.
            return load_is_current(seq, refresh_event) ? 'comparison-stale' : 'stale';
        }
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
            && await built_source_currency(seq, candidate, refresh_event) !== 'current'
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
                    candidate_meta.sheets,
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
                inspected.meta().sheets,
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
        // Set when none of the session's edited worksheets remains in the
        // reloaded workbook. The release runs after the transfer, not inside the
        // installer, so it cannot reorder itself against the adoption it reacts to.
        let lost_all_edited_sheets = false;
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
                    ...(compare_mode ? { onRowWindowServed: start_compare_diff } : {}),
                },
                (installed) => {
                    installed.begin_receiver_epoch(session.current_receiver_epoch);
                    const material = installed.snapshot_material();
                    const owned_before_projection = owns_edit_session();
                    // Reconcile the slots against the workbook being installed
                    // before the projection reads them: an external reorder moves
                    // sheets and their durable slots separately, and projecting
                    // unreconciled slots reads the wrong sheet's, finds nothing,
                    // and drops the leaf — the user's restored draft silently
                    // vanishing from the grid while still sitting on disk. The
                    // session itself is workbook-scoped and has nothing to move;
                    // whether it survives the adoption is a per-slot question the
                    // reconciled leaf answers.
                    const next_sheets = next.meta().sheets;
                    const reconciled_snapshot = reconciled_against(
                        projected_state ?? committed.receipt.stateSnapshot,
                        next,
                    );
                    const adoption_state = project_state_for_panel(
                        reconciled_snapshot,
                        true,
                        next_sheets,
                    );
                    // Every worksheet this session's durable work names is gone
                    // from the reloaded workbook: nothing is left for the session
                    // to represent, so it is released after the transfer. The
                    // drafts stay durable — parked, and back when their names are.
                    // Volatile target observations cover the same boundary before
                    // a live editor has published its first complete map.
                    const reconciled_edits =
                        (reconciled_snapshot.state as PerFileState).pendingEdits;
                    const has_durable_targets = has_any_pending_edits(reconciled_edits);
                    const durable_targets_survive = has_durable_targets
                        && has_rehydratable_pending_edits(reconciled_edits, next_sheets);
                    const active_volatile_target = active_edit_session_id === undefined
                        ? undefined
                        : active_edit_session_targets.get(active_edit_session_id);
                    const pending_volatile_targets = active_edit_session_id === undefined
                        ? undefined
                        : pending_edit_session_targets.get(active_edit_session_id);
                    const has_volatile_targets = active_volatile_target !== undefined
                        || !!pending_volatile_targets?.size;
                    const volatile_targets_survive = active_edit_session_id !== undefined
                        && has_volatile_targets
                        && volatile_edit_targets_survive(
                            active_edit_session_id,
                            next_sheets,
                        );
                    if (
                        owned_before_projection
                        && owns_edit_session()
                        && (has_durable_targets || has_volatile_targets)
                        && !durable_targets_survive
                        && !volatile_targets_survive
                    ) {
                        lost_all_edited_sheets = true;
                    }
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
                                diffOnByDefault: host.config.diff_on_by_default(),
                                ...compare_configuration(next),
                                ...lfs_configuration(),
                            },
                            capabilities: {
                                csvEditingSupported: editing_supported,
                                csvEditable: editing_supported
                                    && may_retain_capability()
                                    && !next.truncationMessage,
                                csvSaveLifecycle: projected_save_lifecycle(),
                                appendRowCeiling: projected_append_row_ceiling(
                                    profile,
                                ),
                                ...(owns_edit_session() && active_edit_session_id
                                    ? { csvEditSessionId: active_edit_session_id }
                                    : {}),
                                ...(editing_supported && profile.edit_syntax
                                    ? { editSyntax: profile.edit_syntax }
                                    : {}),
                            },
                            stateSnapshot: adoption_state,
                        }),
                    };
                    // A freshly rehydrated session validates every projected
                    // slot's bases against the installed workbook. The first
                    // sheet whose bases moved is reported; one rejection is
                    // enough to tell the user their restored draft conflicts.
                    const restored_leaf =
                        (adoption_state.state as PerFileState).pendingEdits;
                    if (
                        !owned_before_projection
                        && owns_edit_session()
                        && active_edit_session_id
                        && restored_leaf
                    ) {
                        try {
                            // DataSource reads are synchronous by contract. Validate against
                            // this exact source during installation, with SAVE_WINDOW bounding
                            // each read; delivery of any verdict still waits for acknowledgement.
                            for (
                                let restored_sheet_index = 0;
                                restored_sheet_index < restored_leaf.length;
                                restored_sheet_index += 1
                            ) {
                                const restored_pending_edits = pending_edits_for_sheet(
                                    restored_leaf,
                                    restored_sheet_index,
                                    next_sheets[restored_sheet_index]?.name,
                                    next_sheets[restored_sheet_index]?.worksheetId,
                                );
                                if (!restored_pending_edits) continue;
                                const validation = validate_restored_pending_edits(
                                    next,
                                    restored_pending_edits,
                                    restored_sheet_index,
                                );
                                if (!validation) continue;
                                const parsed = parse_save_operation({
                                    editSessionId: active_edit_session_id,
                                    saveRequestId: `rehydration:${seq}`,
                                    worksheets: [{
                                        sheetIndex: restored_sheet_index,
                                        sheetName: next_sheets[restored_sheet_index]?.name,
                                        worksheetId: next_sheets[restored_sheet_index]?.worksheetId,
                                        edits: Object.fromEntries(Object.entries(
                                            validation.dirtyEdits,
                                        ).flatMap(([key, entry]) => (
                                            dirty_entry_value_changed(entry)
                                                ? [[key, entry.value] as const]
                                                : []
                                        ))),
                                        dirtyEdits: validation.dirtyEdits,
                                    }],
                                }, next_sheets);
                                if (parsed.status === 'malformed') {
                                    throw new Error('Restored save operation held malformed edits.');
                                }
                                pending_rehydration_rejections.set(adoption, {
                                    operation: parsed.operation,
                                    rejection: validation.rejection,
                                });
                                break;
                            }
                        } catch (error) {
                            log_sanitized_failure(
                                'Failed to validate restored CSV edit bases',
                                error,
                            );
                        }
                    }
                    // Until this adoption's snapshot is acknowledged, the renderer
                    // still indexes sheets using the preceding workbook projection.
                    core = installed;
                    source = next;
                    source_authority = committed.receipt.resultingBasis;
                    // An unspent replay lease is bound to the source and core
                    // being replaced here, so it can no longer be spent. Its own
                    // currency predicate would refuse the commit anyway; dropping
                    // it now is what stops it from holding the one-at-a-time slot
                    // and reporting `busy` to every replay until its TTL runs out.
                    // A COMMITTING lease is deliberately left alone — its answer
                    // must stay recoverable by a lost acknowledgement.
                    replay_leases.invalidate();
                    sync_active_transform_panel();
                    session.replace_adoption(adoption, () => {
                        confirm_transfer();
                        source_observation = candidate.observation;
                        adopted = next;
                    });
                },
            );
            if (result.type === 'refused') return;
        });
        if (!transferred || !adopted || disposed) return undefined;
        if (lost_all_edited_sheets && active_edit_session_id) {
            const edit_session_id = active_edit_session_id;
            void establish_pending_edit_flush_boundary('worksheet-loss')
                .then(async (flushed) => {
                    if (flushed.editSessionId !== edit_session_id) {
                        throw new Error(
                            'Viewer renderer flushed a different edit session after worksheet loss.',
                        );
                    }
                    const current_snapshot = await read_file_state(false);
                    if (active_edit_session_id !== edit_session_id) return;
                    const current_sheets = source?.meta().sheets ?? [];
                    const current_edits = normalize_host_state(
                        current_snapshot.state,
                        current_sheets,
                    ).pendingEdits;
                    const durable_target_survives = has_any_pending_edits(current_edits)
                        && has_rehydratable_pending_edits(current_edits, current_sheets);
                    if (
                        durable_target_survives
                        || volatile_edit_targets_survive(edit_session_id, current_sheets)
                    ) return;
                    await release_edit_session(edit_session_id);
                })
                .catch((error) => {
                    log_sanitized_failure(
                        'Failed to flush and release an edit session whose edited sheets are gone',
                        error,
                    );
                });
        }
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
                            source.meta().sheets,
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
                                        diffOnByDefault: host.config.diff_on_by_default(),
                                        ...compare_configuration(source),
                                        ...lfs_configuration(),
                                    },
                                    capabilities: {
                                        csvEditingSupported: editing_supported,
                                        csvEditable: editing_supported
                                            && may_retain_capability()
                                            && !source!.truncationMessage,
                                        csvSaveLifecycle: projected_save_lifecycle(),
                                        appendRowCeiling: projected_append_row_ceiling(
                                            profile,
                                        ),
                                        ...(owns_edit_session() && active_edit_session_id
                                            ? { csvEditSessionId: active_edit_session_id }
                                            : {}),
                                        ...(editing_supported && profile.edit_syntax
                                            ? { editSyntax: profile.edit_syntax }
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
                // The request id AND the gesture's deltas travel together, and
                // only to the receiver that asked: a delta is the authority for
                // entering something in THAT window's undo history, and another
                // window's gesture must never enter it.
                ...(receipt.originToken === cell_highlight_subscriber_token
                    ? { requestId: receipt.requestId, deltas: receipt.deltas }
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
    async function clear_pending_edits(
        scope: EditCleanupScope,
    ): Promise<FileStateSnapshot> {
        const committed = await update_file_state((current, sheets) => {
            if (!current.pendingEdits) return current;
            if (scope.type === 'workbook') {
                // The one workbook dialog discards the entire session, including
                // parked drafts whose worksheets are temporarily absent. Keeping a
                // durable slot after the renderer cleared its matching parked store
                // would make discarded edits reappear when that worksheet returns.
                const { pendingEdits: _drop, ...rest } = current;
                return rest;
            }
            // Resolved inside the updater, because `current` has already been
            // reconciled against the adopted workbook: after a reorder the captured
            // position is somebody else's slot. A named worksheet that no longer
            // resolves was deleted, and there is nothing of this session's left to
            // clear — its slot went with it.
            //
            // A disposed panel has no source to resolve against, but another window
            // still attached does, and can commit reconciled slots this clear then
            // reads — so the captured position may already be someone else's. The
            // durable slots' own tags answer without a workbook; see
            // `slot_index_tagged`.
            let next: PerFileState['pendingEdits'] = current.pendingEdits;
            for (const saved of scope.targets) {
                const has_identity = saved.worksheetId !== undefined
                    || saved.sheetName !== undefined;
                const target = !has_identity
                    ? saved.sheetIndex
                    : source
                        ? sheet_index_identified(saved.worksheetId, saved.sheetName, sheets)
                        : slot_index_identified(
                            next,
                            saved.worksheetId,
                            saved.sheetName,
                            saved.sheetIndex,
                        );
                if (target === undefined) continue;
                next = with_pending_changes_for_sheet(
                    next,
                    target,
                    undefined,
                    saved.sheetName,
                    saved.worksheetId,
                );
            }
            if (next === current.pendingEdits) return current;
            if (next) return { ...current, pendingEdits: next };
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
                    const snapshot = await clear_pending_edits(phase.scope);
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

    async function report_refresh_failure(
        error: unknown,
        initial: boolean,
        request: Pick<PanelLoadRequest, 'seq' | 'refreshEvent'>,
        post_save = false,
    ): Promise<void> {
        if (initial) {
            await host.ui.show_error(
                error instanceof Error ? error.message : String(error),
            );
            if (load_is_current(request.seq, request.refreshEvent)) {
                await options.requestClose?.();
            }
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
            void host.ui.show_error(message);
        }
    }

    function candidate_matches_acknowledged_source(candidate: SourceCandidate): boolean {
        return candidate.observation.digest === session.acknowledged_physical_digest()
            && candidate.observation.comparisonDigest
                === source_observation?.comparisonDigest;
    }

    function source_row_projections_match(
        previous: DataSource | undefined,
        next: DataSource,
    ): boolean {
        if (!previous) return false;
        const previous_sheets = previous.meta().sheets;
        const next_sheets = next.meta().sheets;
        if (previous_sheets.length !== next_sheets.length) return false;
        return previous_sheets.every((sheet, sheet_index) => {
            const next_sheet = next_sheets[sheet_index];
            if (!next_sheet) return false;
            const previous_signature = source_row_projection_signature(
                previous,
                sheet_index,
            );
            const next_signature = source_row_projection_signature(next, sheet_index);
            return previous_signature !== undefined
                && previous_signature === next_signature
                && sheet.name === next_sheet.name
                && sheet.worksheetId === next_sheet.worksheetId
                && sheet.rowCount === next_sheet.rowCount
                && sheet.sourceRowCount === next_sheet.sourceRowCount
                && sheet.columnCount === next_sheet.columnCount;
        });
    }

    function dispose_unadopted_candidate(candidate: SourceCandidate | undefined): void {
        if (!candidate) return;
        try {
            candidate.dispose();
        } catch (error) {
            log_sanitized_failure('Failed to close unused table source', error);
        }
    }

    function unstable_comparison_error(): Error {
        return new Error('The original version changed while the comparison was being refreshed.');
    }

    async function run_physical_refresh(
        request: PanelLoadRequest,
        force: boolean,
        reason: 'ready' | 'fileReload' | 'recovery',
        initial = false,
    ): Promise<FileRefreshSubscriberResult> {
        let attempts = 0;
        let include_compare_original = true;
        let comparison_fallback_error: Error | undefined;
        let last_error: unknown = new Error('The file changed while it was being refreshed.');
        for (;;) {
            if (!load_is_current(request.seq, request.refreshEvent)) {
                return inactive_refresh_result();
            }
            let candidate: SourceCandidate | undefined;
            let comparison_stale = false;
            try {
                const expected_authority = file_coordinator.authority().authorityRevision;
                const build = await build_source_with_file_size_decision(
                    request,
                    initial,
                    include_compare_original,
                );
                if (build.type === 'stale') return inactive_refresh_result();
                if (build.type === 'stopped') return { type: 'completed' };
                candidate = build.candidate;
                if (!load_is_current(request.seq, request.refreshEvent)) {
                    return inactive_refresh_result();
                }
                const currency = await built_source_currency(
                    request.seq,
                    candidate,
                    request.refreshEvent,
                );
                if (currency !== 'current') {
                    if (!load_is_current(request.seq, request.refreshEvent)) {
                        return inactive_refresh_result();
                    }
                    comparison_stale = currency === 'comparison-stale';
                    last_error = comparison_stale
                        ? unstable_comparison_error()
                        : new Error('The file changed while it was being refreshed.');
                } else if (
                    !force
                    && candidate_matches_acknowledged_source(candidate)
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
                        source_observation = candidate.observation;
                        source_authority = deduplicated.receipt.resultingBasis;
                        update_session_state_material(
                            deduplicated.receipt.stateSnapshot,
                            true,
                        );
                        if (comparison_fallback_error) {
                            warn_compare_unavailable(comparison_fallback_error);
                        }
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
                        // A postSave episode may absorb watcher work that arrived
                        // during the checked-write reservation. The digest proves
                        // this candidate is the save's own bytes, while the source
                        // signatures prove those bytes did not change display-row
                        // identity. Absorbed external bytes, compare alignments and
                        // changed header projections retain reload semantics.
                        const adoption_reason = request.refreshEvent?.reason === 'postSave'
                            && request.refreshEvent.savedDigest
                                === candidate.observation.digest
                            && source_row_projections_match(source, candidate.borrow())
                            ? 'save'
                            : reason;
                        const adopted = adopt_committed_candidate(
                            candidate,
                            committed,
                            request.seq,
                            adoption_reason,
                            editing_supported ? await read_file_state() : undefined,
                            request.refreshEvent,
                        );
                        if (!load_is_current(request.seq, request.refreshEvent)) {
                            return inactive_refresh_result();
                        }
                        if (adopted) {
                            if (comparison_fallback_error) {
                                warn_compare_unavailable(comparison_fallback_error);
                            }
                            return { type: 'completed' };
                        }
                    }
                    last_error = new Error('The file authority changed while it was refreshed.');
                }
            } catch (error) {
                if (!load_is_current(request.seq, request.refreshEvent)) {
                    return inactive_refresh_result();
                }
                // The user cancelled the comparison, and the window is closing:
                // retrying it, or reporting it as a load failure, would argue
                // with a decision already made. A *superseded* alignment also
                // throws this, but never reaches here — the currency check
                // above returns first, leaving the retry to the newer load that
                // superseded it.
                if (error instanceof AlignmentCancelledError) {
                    return { type: 'completed' };
                }
                last_error = error;
            } finally {
                dispose_unadopted_candidate(candidate);
            }
            if (attempts >= RELOAD_RETRY_COUNT) {
                if (!load_is_current(request.seq, request.refreshEvent)) {
                    return inactive_refresh_result();
                }
                if (comparison_stale && include_compare_original) {
                    include_compare_original = false;
                    comparison_fallback_error = unstable_comparison_error();
                    attempts = 0;
                    continue;
                }
                await report_refresh_failure(
                    last_error,
                    initial,
                    request,
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
        include_compare_original = true,
    ): Promise<boolean> {
        if (!load_is_current(request.seq)) return false;
        let candidate: SourceCandidate | undefined;
        try {
            const expected_authority = file_coordinator.authority().authorityRevision;
            const build = await build_source_with_file_size_decision(
                request,
                initial,
                include_compare_original,
            );
            if (build.type !== 'candidate') return false;
            candidate = build.candidate;
            const currency = await built_source_currency(request.seq, candidate);
            if (currency !== 'current') {
                const retry_scheduled = schedule_local_refresh_retry(
                    request,
                    force,
                    reason,
                    initial,
                    include_compare_original,
                );
                if (!retry_scheduled && load_is_current(request.seq)) {
                    if (currency === 'comparison-stale' && include_compare_original) {
                        reset_reload_retry();
                        dispose_unadopted_candidate(candidate);
                        candidate = undefined;
                        return run_local_refresh_attempt(
                            request,
                            force,
                            reason,
                            initial,
                            false,
                        );
                    }
                    dispose_unadopted_candidate(candidate);
                    candidate = undefined;
                    await report_refresh_failure(
                        currency === 'comparison-stale'
                            ? unstable_comparison_error()
                            : new Error('The file changed while it was being refreshed.'),
                        initial,
                        request,
                    );
                }
                return false;
            }
            if (!force && candidate_matches_acknowledged_source(candidate)) {
                const deduplicated = await commit_physical_candidate(
                    candidate, request.seq, expected_authority, true,
                );
                if (deduplicated.type === 'committed' && load_is_current(request.seq)) {
                    source_observation = candidate.observation;
                    source_authority = deduplicated.receipt.resultingBasis;
                    update_session_state_material(deduplicated.receipt.stateSnapshot, true);
                    if (!include_compare_original) {
                        warn_compare_unavailable(unstable_comparison_error());
                    }
                    reset_reload_retry();
                    return true;
                }
                if (
                    !schedule_local_refresh_retry(
                        request,
                        force,
                        reason,
                        initial,
                        include_compare_original,
                    )
                    && load_is_current(request.seq)
                ) {
                    dispose_unadopted_candidate(candidate);
                    candidate = undefined;
                    await report_refresh_failure(
                        new Error('The file authority changed while it was refreshed.'),
                        initial,
                        request,
                    );
                }
                return false;
            }
            const committed = await commit_physical_candidate(
                candidate, request.seq, expected_authority, true,
            );
            if (committed.type !== 'committed') {
                if (
                    !schedule_local_refresh_retry(
                        request,
                        force,
                        reason,
                        initial,
                        include_compare_original,
                    )
                    && load_is_current(request.seq)
                ) {
                    dispose_unadopted_candidate(candidate);
                    candidate = undefined;
                    await report_refresh_failure(
                        new Error('The file authority changed while it was refreshed.'),
                        initial,
                        request,
                    );
                }
                return false;
            }
            const adopted = adopt_committed_candidate(
                candidate,
                committed,
                request.seq,
                reason,
                editing_supported ? await read_file_state() : undefined,
            );
            if (!adopted) return false;
            if (!include_compare_original) {
                warn_compare_unavailable(unstable_comparison_error());
            }
            reset_reload_retry();
            return true;
        } catch (error) {
            if (!load_is_current(request.seq)) return false;
            if (error instanceof AlignmentCancelledError) return false;
            if (!schedule_local_refresh_retry(
                request,
                force,
                reason,
                initial,
                include_compare_original,
            )) {
                dispose_unadopted_candidate(candidate);
                candidate = undefined;
                await report_refresh_failure(error, initial, request);
            }
            return false;
        } finally {
            dispose_unadopted_candidate(candidate);
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

    function refresh_if_changed(): Promise<boolean> {
        return refresh_panel_source(false);
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
        // A watcher can supersede the ready-triggered load before any source is
        // adopted. Its failure is still an initial-load failure: treating it as
        // an ordinary reload would leave an empty renderer on "Loading..." after
        // the superseded dialog correctly declines to close a newer request.
        const initial = source_observation === undefined;
        return run_physical_refresh(
            request,
            projection_recovery,
            projection_recovery ? 'recovery' : 'fileReload',
            initial,
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
        include_compare_original: boolean,
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
                void run_local_refresh_attempt(
                    request,
                    force,
                    reason,
                    initial,
                    include_compare_original,
                ).catch((error: unknown) => {
                    log_sanitized_failure('Failed to retry table viewer refresh', error);
                });
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

    async function admit_append_rows(
        message: Extract<WebviewMessage, { type: 'requestAppendRows' }>,
        receiver_epoch: number,
    ): Promise<void> {
        if (row_admission_request_ids.has(message.requestId)) {
            await post_to_receiver({
                type: 'appendRowsResult',
                requestId: message.requestId,
                sourceGeneration: message.sourceGeneration,
                granted: false,
                reason: 'This row-admission request identity is already active.',
            }, receiver_epoch);
            return;
        }
        row_admission_request_ids.add(message.requestId);
        const refuse = (reason: string): Promise<boolean> => {
            row_admission_request_ids.delete(message.requestId);
            return post_to_receiver({
                type: 'appendRowsResult',
                requestId: message.requestId,
                sourceGeneration: message.sourceGeneration,
                granted: false,
                reason,
            }, receiver_epoch);
        };
        if (
            !editing_supported
            || !edit_message_is_current(message.editSessionId)
            || receiver_epoch !== session.current_receiver_epoch
            || !core
            || !source
            || message.sourceGeneration !== core.source_generation
        ) {
            await refuse('The edit session or worksheet changed. Try appending again.');
            return;
        }
        const requested_target = sanitized_wire_worksheet_target(message.worksheet);
        if (!requested_target) {
            await refuse('The worksheet identity is invalid.');
            return;
        }
        const target = canonical_worksheet_target(requested_target);
        const sheet_index = target?.sheetIndex;
        if (target === undefined || sheet_index !== requested_target.sheetIndex) {
            await refuse('The worksheet was removed or reordered.');
            return;
        }
        const sheet = source.meta().sheets[sheet_index];
        if (
            !Number.isSafeInteger(message.count)
            || message.count <= 0
            || message.count > MAX_PENDING_APPENDED_ROWS
        ) {
            await refuse(`Append at most ${MAX_PENDING_APPENDED_ROWS.toLocaleString('en-US')} rows at once.`);
            return;
        }
        if (source.truncationMessage) {
            await refuse('Load the complete delimited file before appending rows.');
            return;
        }
        if (sheet.columnCount <= 0) {
            await refuse('This worksheet has no columns to append into.');
            return;
        }

        const state_snapshot = await read_file_state();
        if (
            !edit_message_is_current(message.editSessionId)
            || receiver_epoch !== session.current_receiver_epoch
            || !core
            || !source
            || message.sourceGeneration !== core.source_generation
        ) {
            await refuse('The source changed while the row was being prepared.');
            return;
        }
        const state = (reconciled_against(state_snapshot, source).state) as PerFileState;
        const visibility = create_column_projection(
            sheet.columnCount,
            state.columnVisibility?.[sheet_index],
            transform_schema_for_sheet(sheet),
        );
        if (visibility.visible_to_source.length === 0) {
            await refuse('Show at least one column before appending a row.');
            return;
        }
        const reconciled = reconcile_pending_edit_sheets(
            state.pendingEdits,
            source.meta().sheets,
        );
        const durable = pending_changes_for_sheet(
            reconciled,
            sheet_index,
            sheet.name,
            sheet.worksheetId,
        );
        const ledger_key = append_ledger_key(message.editSessionId, target);
        let ledger = append_admission_ledgers.get(ledger_key);
        if (!ledger) {
            ledger = {
                ownedRowIds: new Set(),
                templateIdByRowId: new Map(),
                reservedRowIds: new Map(),
                unsettledRequestByRowId: new Map(),
                sourceGeneration: message.sourceGeneration,
            };
            append_admission_ledgers.set(ledger_key, ledger);
        }
        if (unsettled_reservation_for_ledger(ledger_key) !== undefined) {
            await refuse('Another row append is still being installed. Try again.');
            return;
        }
        const provisional_ledger_basis = accepted_append_basis_for_ledger(
            ledger,
            ledger_key,
        );
        const admitted_ids = new Set(durable?.appendedRows?.map((row) => row.id) ?? []);
        for (const id of ledger.reservedRowIds.keys()) admitted_ids.add(id);
        // The product limit is deliberately session-lifetime, not merely the
        // number still visible. Otherwise append/remove loops retain an
        // unbounded host capability set while always appearing below quota.
        if (ledger.ownedRowIds.size + message.count > MAX_PENDING_APPENDED_ROWS) {
            await refuse(`A worksheet may keep at most ${MAX_PENDING_APPENDED_ROWS.toLocaleString('en-US')} pending rows.`);
            return;
        }
        const prospective_rows = sheet.sourceRowCount
            - (durable?.tailRemovals?.length ?? 0)
            + admitted_ids.size
            + message.count;
        if (prospective_rows > append_row_ceiling_for(profile)) {
            await refuse('Appending these rows would exceed the worksheet row limit.');
            return;
        }

        const schemaFingerprint = worksheet_append_schema_fingerprint(sheet);
        if (
            durable?.appendBasis !== undefined
            && (durable.appendBasis.columnCount !== sheet.columnCount
                || durable.appendBasis.schemaFingerprint !== schemaFingerprint)
        ) {
            await refuse('Pending rows need review because the worksheet columns changed.');
            return;
        }

        let format: PendingRowFormatTemplate['format'];
        if (file_path.toLowerCase().endsWith('.xlsx')) {
            const observation = source_observation;
            if (!observation) {
                await refuse('The workbook source is not ready for an append.');
                return;
            }
            const raw = await host.fs.read_file(uri);
            if (
                content_digest(raw) !== observation.digest
                || !edit_message_is_current(message.editSessionId)
                || receiver_epoch !== session.current_receiver_epoch
                || !core
                || message.sourceGeneration !== core.source_generation
                || source_observation !== observation
            ) {
                await refuse('The workbook changed while the row format was being captured.');
                return;
            }
            let template_source_row = sheet.sourceRowCount === 0
                ? undefined
                : sheet.sourceRowCount - 1;
            if (
                template_source_row !== undefined
                && sheet.excelFirstRowHeader?.active === true
                && sheet.excelFirstRowHeader.sourceRow === template_source_row
            ) {
                template_source_row = template_source_row === 0
                    ? undefined
                    : template_source_row - 1;
            }
            const viewer_height = template_source_row === undefined
                ? undefined
                : state.rowHeights?.[sheet_index]?.[template_source_row];
            try {
                format = capture_xlsx_append_row_format(
                    raw,
                    sheet_index,
                    sheet.sourceRowCount,
                    sheet.columnCount,
                    sheet.excelFirstRowHeader?.active === true
                        ? sheet.excelFirstRowHeader.sourceRow
                        : undefined,
                    viewer_height,
                );
            } catch (error) {
                await refuse(error instanceof Error
                    ? error.message
                    : 'The final worksheet row cannot be used as a format template.');
                return;
            }
            if (
                durable?.appendBasis?.styleFingerprint !== undefined
                && durable.appendBasis.styleFingerprint !== format.styleFingerprint
            ) {
                await refuse('Pending rows need review because the workbook styles changed.');
                return;
            }
        } else {
            format = { kind: 'none' };
        }
        const appendBasis: PendingAppendBasis = Object.freeze({
            sourceRowCount: durable?.appendBasis?.sourceRowCount
                ?? provisional_ledger_basis?.sourceRowCount
                ?? sheet.sourceRowCount,
            provisionalStartRow: durable?.appendBasis?.provisionalStartRow
                ?? provisional_ledger_basis?.provisionalStartRow
                ?? sheet.sourceRowCount - (durable?.tailRemovals?.length ?? 0),
            provisionalRowCount: Math.max(
                durable?.appendBasis?.provisionalRowCount ?? 0,
                provisional_ledger_basis?.provisionalRowCount ?? 0,
                admitted_ids.size + message.count,
            ),
            columnCount: sheet.columnCount,
            schemaFingerprint,
            ...(format.kind === 'xlsx'
                ? { styleFingerprint: format.styleFingerprint }
                : {}),
        });
        if (provisional_ledger_basis !== undefined
            && advance_pending_append_basis(provisional_ledger_basis, appendBasis) === undefined) {
            await refuse('Pending rows need review because their worksheet basis changed.');
            return;
        }
        const matching_durable_template = durable?.formatTemplates?.find(
            (candidate) => JSON.stringify(candidate.format) === JSON.stringify(format),
        );
        const formatTemplate = matching_durable_template
            ?? (ledger.formatTemplate !== undefined
                && JSON.stringify(ledger.formatTemplate.format) === JSON.stringify(format)
                ? ledger.formatTemplate
                : Object.freeze({
                    id: `append-template:${randomUUID()}`,
                    format,
                }));
        const rowIds = Object.freeze(Array.from({ length: message.count }, () => {
            const id = `append-row:${randomUUID()}`;
            return id;
        }));
        const tentative_rows = [
            ...(durable?.appendedRows ?? []),
            ...rowIds.map((id, index) => Object.freeze({
                id,
                cells: Object.freeze({}),
                formatTemplateId: formatTemplate.id,
                // Upper-bound the renderer's timestamp-shaped order spelling in
                // the aggregate byte admission estimate.
                createdOrder: Number.MAX_SAFE_INTEGER - rowIds.length + index + 1,
            })),
        ];
        const tentative_templates = durable?.formatTemplates?.some(
            (candidate) => candidate.id === formatTemplate.id,
        ) === true
            ? durable.formatTemplates
            : [...(durable?.formatTemplates ?? []), formatTemplate];
        if (!own_wire_pending_changes({
            ...target,
            cells: durable?.cells ?? {},
            formatTemplates: tentative_templates,
            appendedRows: tentative_rows,
            tailRemovals: durable?.tailRemovals ?? [],
            appendBasis,
            conflicts: durable?.conflicts ?? [],
        })) {
            await refuse('Appending these rows would exceed the pending-changes size limit.');
            return;
        }
        if (receiver_epoch !== session.current_receiver_epoch
            || !edit_message_is_current(message.editSessionId)) {
            row_admission_request_ids.delete(message.requestId);
            return;
        }
        const template_authority_owner = reservation_template_authority_owner(
            message.requestId,
        );
        if (!append_admission_template_authorities.reserve(
            template_authority_owner,
            [formatTemplate],
        )) {
            await refuse('Pending row format history has reached its memory limit.');
            return;
        }
        for (const id of rowIds) {
            ledger.ownedRowIds.add(id);
            ledger.templateIdByRowId.set(id, formatTemplate.id);
            ledger.reservedRowIds.set(id, highest_pending_edit_sequence + 1);
            ledger.unsettledRequestByRowId.set(id, message.requestId);
        }
        row_admission_reservations.set(message.requestId, {
            purpose: 'append',
            editSessionId: message.editSessionId,
            ledgerKey: ledger_key,
            gestureRowIds: rowIds,
            rowIds,
            appendBasis,
            templates: Object.freeze([formatTemplate]),
            templateAuthorityOwner: template_authority_owner,
            appendTemplate: formatTemplate,
            sourceGeneration: message.sourceGeneration,
            state: 'unsettled',
        });
        const delivered = await post_to_receiver({
            type: 'appendRowsResult',
            requestId: message.requestId,
            sourceGeneration: message.sourceGeneration,
            granted: true,
            rowIds,
            formatTemplate,
            appendBasis,
        }, receiver_epoch);
        if (!delivered) {
            settle_row_admission({
                type: 'settleRowAdmission',
                requestId: message.requestId,
                editSessionId: message.editSessionId,
                accepted: false,
            });
        }
    }

    async function validate_tail_removal_replay(
        message: Extract<WebviewMessage, { type: 'validateTailRemovalReplay' }>,
    ): Promise<void> {
        const reply = (valid: boolean) => post_to_receiver({
            type: 'tailRemovalReplayValidated' as const,
            requestId: typeof message.requestId === 'string' ? message.requestId : '',
            sourceGeneration: Number.isSafeInteger(message.sourceGeneration)
                ? message.sourceGeneration
                : -1,
            valid,
        });
        if (
            !edit_message_is_current(message.editSessionId)
            || !core
            || !source
            || message.sourceGeneration !== core.source_generation
            || !Array.isArray(message.worksheets)
            || message.worksheets.length > source.meta().sheets.length
        ) {
            await reply(false);
            return;
        }
        const observation = source_observation;
        if (!observation) {
            await reply(false);
            return;
        }
        let raw: Uint8Array;
        try {
            raw = await host.fs.read_file(uri);
        } catch {
            await reply(false);
            return;
        }
        if (
            content_digest(raw) !== observation.digest
            || source_observation !== observation
            || !edit_message_is_current(message.editSessionId)
        ) {
            await reply(false);
            return;
        }
        let removal_count = 0;
        try {
            const seen = new Set<number>();
            for (const requested of message.worksheets) {
                const target = sanitized_wire_worksheet_target(requested);
                if (!target || !Array.isArray(requested.removals)) throw new Error('invalid');
                const sheet_index = worksheet_target_index(source.meta().sheets, target);
                if (sheet_index === undefined) throw new Error('invalid');
                const sheet = source.meta().sheets[sheet_index];
                if (!sheet || seen.has(sheet_index)) throw new Error('invalid');
                seen.add(sheet_index);
                removal_count += requested.removals.length;
                if (removal_count > MAX_PENDING_APPENDED_ROWS) throw new Error('invalid');
                for (const [index, removal] of requested.removals.entries()) {
                    if (
                        !is_plain_record(removal)
                        || typeof removal.appendHistoryId !== 'string'
                        || removal.appendHistoryId.length === 0
                        || removal.appendHistoryId.length > 256
                        || !Number.isSafeInteger(removal.sourceRow)
                        || removal.sourceRow !== sheet.sourceRowCount
                            - requested.removals.length + index
                        || typeof removal.savedFingerprint !== 'string'
                        || removal.savedFingerprint.length === 0
                        || removal.savedFingerprint.length > 256
                    ) throw new Error('invalid');
                    const source_row = removal.sourceRow as number;
                    const append_history_id = removal.appendHistoryId as string;
                    const saved_fingerprint = removal.savedFingerprint as string;
                    const authority = saved_append_authority_for(target, append_history_id);
                    if (
                        authority === undefined
                        || authority.state !== 'physical'
                        || authority.sourceRow !== source_row
                        || authority.savedFingerprint !== saved_fingerprint
                    ) throw new Error('unauthorized');
                    const format = file_path.toLowerCase().endsWith('.xlsx')
                        ? capture_xlsx_append_row_format(
                            raw,
                            sheet_index,
                            source_row + 1,
                            sheet.columnCount,
                            sheet.excelFirstRowHeader?.active === true
                                ? sheet.excelFirstRowHeader.sourceRow
                                : undefined,
                        )
                        : { kind: 'none' as const };
                    const fingerprint = saved_row_physical_fingerprint({
                        cells: source_row_cells_for_fingerprint(
                            source,
                            sheet_index,
                            source_row,
                        ),
                        format,
                    });
                    if (fingerprint !== saved_row_physical_fingerprint(
                        authority.savedRow,
                    )) throw new Error('changed');
                }
            }
            await reply(true);
        } catch {
            await reply(false);
        }
    }

    function settle_row_admission(
        message: Extract<WebviewMessage, { type: 'settleRowAdmission' }>,
        replay_lease_id?: string,
    ): boolean {
        const reservation = row_admission_reservations.get(message.requestId);
        if (reservation === undefined
            || reservation.editSessionId !== message.editSessionId
            || reservation.state !== 'unsettled') return false;
        if (
            reservation.replayLeaseId !== undefined
            && reservation.replayLeaseId !== replay_lease_id
        ) return false;
        const ledger = append_admission_ledgers.get(reservation.ledgerKey);
        if (ledger === undefined) {
            append_admission_template_authorities.forget_owner(
                reservation.templateAuthorityOwner,
            );
            row_admission_reservations.delete(message.requestId);
            row_admission_request_ids.delete(message.requestId);
            return false;
        }
        let accepted = message.accepted === true;
        if (accepted) {
            const provisional_basis = accepted_append_basis_for_ledger(
                ledger,
                reservation.ledgerKey,
            );
            const advanced = provisional_basis === undefined
                ? reservation.appendBasis
                : advance_pending_append_basis(provisional_basis, reservation.appendBasis);
            if (advanced === undefined) {
                accepted = false;
            }
        }
        for (const row_id of reservation.rowIds) {
            if (ledger.unsettledRequestByRowId.get(row_id) !== message.requestId) continue;
            ledger.unsettledRequestByRowId.delete(row_id);
            if (accepted) {
                ledger.reservedRowIds.set(row_id, highest_pending_edit_sequence + 1);
                continue;
            }
            ledger.reservedRowIds.delete(row_id);
            ledger.ownedRowIds.delete(row_id);
            ledger.templateIdByRowId.delete(row_id);
        }
        if (accepted) {
            reservation.state = 'accepted';
            reservation.firstPublicationSequence = highest_pending_edit_sequence + 1;
            reservation.replayLeaseId = undefined;
            return true;
        }
        append_admission_template_authorities.forget_owner(
            reservation.templateAuthorityOwner,
        );
        row_admission_reservations.delete(message.requestId);
        row_admission_request_ids.delete(message.requestId);
        return true;
    }

    async function admit_saved_row_restoration(
        message: Extract<WebviewMessage, { type: 'requestRestoreSavedRows' }>,
        receiver_epoch: number,
    ): Promise<void> {
        if (row_admission_request_ids.has(message.requestId)) {
            await post_to_receiver({
                type: 'restoreSavedRowsResult',
                requestId: message.requestId,
                sourceGeneration: message.sourceGeneration,
                granted: false,
                reason: 'This row-admission request identity is already active.',
            }, receiver_epoch);
            return;
        }
        row_admission_request_ids.add(message.requestId);
        const refuse = (reason: string): Promise<boolean> => {
            row_admission_request_ids.delete(message.requestId);
            return post_to_receiver({
                type: 'restoreSavedRowsResult',
                requestId: message.requestId,
                sourceGeneration: message.sourceGeneration,
                granted: false,
                reason,
            }, receiver_epoch);
        };
        if (
            !editing_supported
            || !edit_message_is_current(message.editSessionId)
            || receiver_epoch !== session.current_receiver_epoch
            || !core
            || !source
            || message.sourceGeneration !== core.source_generation
        ) {
            await refuse('The edit session or worksheet changed. Try restoring again.');
            return;
        }
        const requested_target = sanitized_wire_worksheet_target(message.worksheet);
        const ids = Array.isArray(message.appendHistoryIds)
            ? message.appendHistoryIds
            : [];
        if (
            !requested_target
            || ids.length === 0
            || ids.length > MAX_PENDING_APPENDED_ROWS
            || new Set(ids).size !== ids.length
            || ids.some((id) => typeof id !== 'string' || id.length === 0 || id.length > 128)
        ) {
            await refuse('The saved-row restoration request is invalid.');
            return;
        }
        const target = canonical_worksheet_target(requested_target);
        if (target === undefined) {
            await refuse('The worksheet was removed.');
            return;
        }
        const sheet_index = target.sheetIndex;
        const sheet = source.meta().sheets[sheet_index];
        if (!sheet) {
            await refuse('The worksheet was removed.');
            return;
        }
        const authorities = ids.map((id) => saved_append_authority_for(target, id));
        if (authorities.some((authority) => authority?.state !== 'removed')) {
            await refuse('The saved appended row is no longer restorable.');
            return;
        }
        const state_snapshot = await read_file_state();
        if (!edit_message_is_current(message.editSessionId)
            || receiver_epoch !== session.current_receiver_epoch
            || !source || !core) {
            await refuse('The source changed while the saved row was being restored.');
            return;
        }
        const state = state_snapshot.state as PerFileState;
        const reconciled = reconcile_pending_edit_sheets(
            state.pendingEdits,
            source.meta().sheets,
        );
        const durable = pending_changes_for_sheet(
            reconciled,
            sheet_index,
            sheet.name,
            sheet.worksheetId,
        );
        const ledger_key = append_ledger_key(message.editSessionId, target);
        const ledger = append_admission_ledgers.get(ledger_key) ?? {
            ownedRowIds: new Set<string>(),
            templateIdByRowId: new Map<string, string>(),
            reservedRowIds: new Map<string, number>(),
            unsettledRequestByRowId: new Map<string, string>(),
            sourceGeneration: message.sourceGeneration,
        };
        append_admission_ledgers.set(ledger_key, ledger);
        if (unsettled_reservation_for_ledger(ledger_key) !== undefined) {
            await refuse('Another row restoration is still being installed. Try again.');
            return;
        }
        const provisional_ledger_basis = accepted_append_basis_for_ledger(
            ledger,
            ledger_key,
        );
        const new_ids = ids.filter((id) => !ledger.ownedRowIds.has(id));
        if (ledger.ownedRowIds.size + new_ids.length > MAX_PENDING_APPENDED_ROWS) {
            await refuse(`A worksheet may keep at most ${MAX_PENDING_APPENDED_ROWS.toLocaleString('en-US')} pending rows.`);
            return;
        }
        const current_ids = new Set(durable?.appendedRows?.map((row) => row.id) ?? []);
        for (const id of ledger.reservedRowIds.keys()) current_ids.add(id);
        const requested_additions = ids.filter((id) => !current_ids.has(id));
        if (
            ids.some((id) => current_ids.has(id) && !ledger.ownedRowIds.has(id))
            || current_ids.size + requested_additions.length > MAX_PENDING_APPENDED_ROWS
            || sheet.sourceRowCount - (durable?.tailRemovals?.length ?? 0)
                + current_ids.size + requested_additions.length
                > append_row_ceiling_for(profile)
        ) {
            await refuse('Restoring these rows would exceed the worksheet row limit.');
            return;
        }
        const schemaFingerprint = worksheet_append_schema_fingerprint(sheet);
        const appendBasis: PendingAppendBasis = Object.freeze({
            sourceRowCount: durable?.appendBasis?.sourceRowCount
                ?? provisional_ledger_basis?.sourceRowCount
                ?? sheet.sourceRowCount,
            provisionalStartRow: durable?.appendBasis?.provisionalStartRow
                ?? provisional_ledger_basis?.provisionalStartRow
                ?? sheet.sourceRowCount - (durable?.tailRemovals?.length ?? 0),
            provisionalRowCount: Math.max(
                durable?.appendBasis?.provisionalRowCount ?? 0,
                provisional_ledger_basis?.provisionalRowCount ?? 0,
                current_ids.size + requested_additions.length,
            ),
            columnCount: sheet.columnCount,
            schemaFingerprint,
            ...(authorities[0]?.savedRow.format.kind === 'xlsx'
                ? { styleFingerprint: authorities[0].savedRow.format.styleFingerprint }
                : {}),
        });
        if (provisional_ledger_basis !== undefined
            && advance_pending_append_basis(provisional_ledger_basis, appendBasis) === undefined) {
            await refuse('Pending rows need review because their worksheet basis changed.');
            return;
        }
        if (file_path.toLowerCase().endsWith('.xlsx')) {
            const observation = source_observation;
            if (!observation) {
                await refuse('The workbook source is not ready for a restoration.');
                return;
            }
            const raw = await host.fs.read_file(uri);
            if (
                content_digest(raw) !== observation.digest
                || source_observation !== observation
                || !edit_message_is_current(message.editSessionId)
                || receiver_epoch !== session.current_receiver_epoch
            ) {
                await refuse('The workbook changed while the saved format was checked.');
                return;
            }
            if (authorities.some((authority) =>
                authority?.savedRow.format.kind !== 'xlsx'
                || authority.savedRow.format.styleFingerprint
                    !== xlsx_append_style_dependency_fingerprint(
                        raw,
                        authority.savedRow.format.cellStyleIndexes,
                        authority.savedRow.format.rowStyleIndex,
                    )
                || authority.savedRow.format.cellStyleIndexes.length !== sheet.columnCount
            )) {
                await refuse('The workbook styles changed after the appended row was saved.');
                return;
            }
        } else if (authorities.some((authority) => authority?.savedRow.format.kind !== 'none')) {
            await refuse('The saved row format no longer matches this file.');
            return;
        }
        const template_by_fingerprint = new Map<string, PendingRowFormatTemplate>();
        const template_for_authority = authorities.map((authority) => {
            const format = authority!.savedRow.format;
            const fingerprint = content_digest(new TextEncoder().encode(JSON.stringify(format)));
            let template = template_by_fingerprint.get(fingerprint);
            if (template === undefined) {
                template = Object.freeze({
                    id: `restored-format:${fingerprint}`,
                    format,
                });
                template_by_fingerprint.set(fingerprint, template);
            }
            return template;
        });
        const templates = [...template_by_fingerprint.values()];
        const tentative_templates = [...(durable?.formatTemplates ?? [])];
        for (const template of templates) {
            const existing = tentative_templates.find((candidate) => candidate.id === template.id);
            if (existing !== undefined && JSON.stringify(existing) !== JSON.stringify(template)) {
                await refuse('A saved row format identity conflicts with current pending work.');
                return;
            }
            if (existing === undefined) tentative_templates.push(template);
        }
        const tentative_rows = [
            ...(durable?.appendedRows ?? []),
            ...authorities.map((authority, index): PendingAppendedRow => ({
                id: ids[index],
                cells: authority!.savedRow.cells,
                formatTemplateId: template_for_authority[index].id,
                createdOrder: Number.MAX_SAFE_INTEGER - ids.length + index + 1,
                ...(authority!.savedRow.viewerRowHeight === undefined
                    ? {}
                    : { viewerRowHeight: authority!.savedRow.viewerRowHeight }),
                ...(authority!.savedRow.highlights === undefined
                    ? {}
                    : { highlights: authority!.savedRow.highlights }),
            })),
        ];
        if (!own_wire_pending_changes({
            ...target,
            cells: durable?.cells ?? {},
            formatTemplates: tentative_templates,
            appendedRows: tentative_rows,
            tailRemovals: durable?.tailRemovals ?? [],
            appendBasis,
            conflicts: durable?.conflicts ?? [],
        })) {
            await refuse('Restoring these rows would exceed the pending-changes size limit.');
            return;
        }
        if (receiver_epoch !== session.current_receiver_epoch
            || !edit_message_is_current(message.editSessionId)) {
            row_admission_request_ids.delete(message.requestId);
            return;
        }
        const template_authority_owner = reservation_template_authority_owner(
            message.requestId,
        );
        if (!append_admission_template_authorities.reserve(
            template_authority_owner,
            templates,
        )) {
            await refuse('Pending row format history has reached its memory limit.');
            return;
        }
        const template_id_by_restored_id = new Map(ids.map(
            (id, index) => [id, template_for_authority[index].id],
        ));
        for (const id of new_ids) {
            ledger.ownedRowIds.add(id);
            ledger.templateIdByRowId.set(id, template_id_by_restored_id.get(id)!);
            ledger.reservedRowIds.set(id, highest_pending_edit_sequence + 1);
            ledger.unsettledRequestByRowId.set(id, message.requestId);
        }
        row_admission_reservations.set(message.requestId, {
            purpose: 'restoration',
            editSessionId: message.editSessionId,
            ledgerKey: ledger_key,
            gestureRowIds: Object.freeze([...ids]),
            rowIds: Object.freeze([...new_ids]),
            appendBasis,
            templates: Object.freeze(templates),
            templateAuthorityOwner: template_authority_owner,
            sourceGeneration: message.sourceGeneration,
            state: 'unsettled',
        });
        const delivered = await post_to_receiver({
            type: 'restoreSavedRowsResult',
            requestId: message.requestId,
            sourceGeneration: message.sourceGeneration,
            granted: true,
            appendHistoryIds: Object.freeze([...ids]),
            appendBasis,
        }, receiver_epoch);
        if (!delivered) {
            settle_row_admission({
                type: 'settleRowAdmission',
                requestId: message.requestId,
                editSessionId: message.editSessionId,
                accepted: false,
            });
        }
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
        void host.ui.show_error(message);
    }

    function finish_save_failure(
        operation: CsvSaveHostOperation,
        warning?: string,
        error?: unknown,
    ): void {
        if (!save_operation_owns_lifecycle(operation)) return;
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
            basesValidated: true,
        });
    }

    type ParsedSaveOperation =
        | { readonly status: 'valid'; readonly operation: CsvSaveOperation }
        | { readonly status: 'malformed'; readonly correlation?: CsvSaveCorrelation };

    /** Validate a structural Save claim without consuming its capabilities. */
    const save_structural_claim_is_authorized = (
        edit_session_id: string,
        target: WorksheetTarget,
        structural: NonNullable<CsvSaveWorksheetOperation['structuralChanges']>,
    ): boolean => {
        const ledger_key = append_ledger_key(edit_session_id, target);
        const live_ledger = append_admission_ledgers.get(ledger_key);
        const ledger = live_ledger === undefined
            ? undefined
            : clone_append_admission_ledger(live_ledger);
        const retained_templates = project_retained_pending_rows(
            ledger,
            target,
            structural.appendedRows,
        );
        if (changes_use_unsettled_row_authority(
            live_ledger,
            ledger_key,
            structural.appendedRows,
            structural.formatTemplates,
            structural.appendBasis,
        )) return false;
        return accepted_row_admission_gestures_are_complete(
            ledger_key,
            structural.appendedRows,
        )
            && appended_rows_match_ledger(ledger, structural.appendedRows)
            && structural.formatTemplates.every((template) => {
                const issued = retained_templates.get(template.id)
                    ?? issued_append_template(live_ledger, ledger_key, template.id);
                return issued !== undefined
                    && JSON.stringify(issued) === JSON.stringify(template);
            })
            && (
                structural.appendBasis === undefined
                || JSON.stringify(structural.appendBasis)
                    === JSON.stringify(accepted_append_basis_for_ledger(
                        ledger,
                        ledger_key,
                    ))
            )
            && structural.tailRemovals.every(
                (removal) => tail_removal_matches_authority(target, removal),
            );
    };

    function parse_save_operation(
        input: unknown,
        authoritative_sheets?: readonly SheetMeta[],
    ): ParsedSaveOperation {
        if (!is_plain_record(input)) return { status: 'malformed' };
        const correlation = is_wire_save_correlation(input)
            ? Object.freeze<CsvSaveCorrelation>({
                editSessionId: input.editSessionId,
                saveRequestId: input.saveRequestId,
            })
            : undefined;
        const malformed = (): ParsedSaveOperation => ({
            status: 'malformed',
            ...(correlation ? { correlation } : {}),
        });
        if (!correlation) return malformed();

        const is_workbook_request = Object.prototype.hasOwnProperty.call(
            input,
            'worksheets',
        );
        if (
            is_workbook_request
            && (!Array.isArray(input.worksheets) || input.worksheets.length === 0)
        ) return malformed();
        const requested_worksheets: readonly unknown[] = is_workbook_request
            ? input.worksheets as readonly unknown[]
            : [input];
        const worksheets: CsvSaveWorksheetOperation[] = [];
        const sheet_indices = new Set<number>();
        const target_keys = new Set<string>();
        for (const requested of requested_worksheets) {
            if (!is_plain_record(requested)) return malformed();
            const target = sanitized_wire_worksheet_target(
                requested,
                is_workbook_request ? undefined : 0,
            );
            const canonical_target = target === undefined
                ? undefined
                : canonical_worksheet_target(target, authoritative_sheets);
            const maps = sanitized_wire_save_maps(
                requested.edits,
                requested.dirtyEdits,
            );
            if (!target || !canonical_target || canonical_target.sheetIndex !== target.sheetIndex
                || !maps) return malformed();
            let structuralChanges: CsvSaveWorksheetOperation['structuralChanges'];
            if (Object.prototype.hasOwnProperty.call(requested, 'structuralChanges')) {
                if (!is_plain_record(requested.structuralChanges)) return malformed();
                const owned = own_wire_pending_changes({
                    ...target,
                    cells: maps.dirtyEdits,
                    ...requested.structuralChanges,
                });
                if (!owned) return malformed();
                structuralChanges = Object.freeze({
                    formatTemplates: owned.formatTemplates,
                    appendedRows: owned.appendedRows,
                    tailRemovals: owned.tailRemovals,
                    ...(owned.appendBasis === undefined
                        ? {}
                        : { appendBasis: owned.appendBasis }),
                    conflicts: owned.conflicts,
                });
                // Save parsing validates renderer claims but does not consume
                // authority. Retained rows are projected into a clone so a Save
                // arriving while publication is awaiting durable state cannot
                // mutate the ledger or the shared template budget underneath it.
                if (!save_structural_claim_is_authorized(
                    correlation.editSessionId,
                    canonical_target,
                    structuralChanges,
                )) return malformed();
            }
            const target_key = worksheet_target_key(canonical_target);
            if (
                sheet_indices.has(target.sheetIndex)
                || target_keys.has(target_key)
            ) return malformed();
            sheet_indices.add(target.sheetIndex);
            target_keys.add(target_key);

            const sheet_name = target.sheetName ?? (
                (source?.meta().sheets.length ?? 0) <= 1
                    ? sheet_name_at(target.sheetIndex)
                    : undefined
            );
            worksheets.push(Object.freeze<CsvSaveWorksheetOperation>({
                sheetIndex: target.sheetIndex,
                ...(sheet_name !== undefined ? { sheetName: sheet_name } : {}),
                ...(target.worksheetId !== undefined
                    ? { worksheetId: target.worksheetId }
                    : {}),
                ...maps,
                ...(structuralChanges === undefined ? {} : { structuralChanges }),
            }));
        }

        const workbook_operation = Object.freeze<CsvSaveOperation>({
            editSessionId: correlation.editSessionId,
            saveRequestId: correlation.saveRequestId,
            worksheets: Object.freeze(worksheets),
        });
        if (is_workbook_request) {
            return { status: 'valid', operation: workbook_operation };
        }

        // Old renderers compare the flat fields they proposed and ignore unknown
        // fields; current renderers compare `worksheets` and ignore these aliases.
        // One hybrid identity therefore settles both generations through every
        // lifecycle channel, including snapshots, without weakening either reducer.
        const worksheet = worksheets[0];
        return {
            status: 'valid',
            operation: Object.freeze({
                ...workbook_operation,
                sheetIndex: worksheet.sheetIndex,
                ...(worksheet.sheetName !== undefined
                    ? { sheetName: worksheet.sheetName }
                    : {}),
                ...(worksheet.worksheetId !== undefined
                    ? { worksheetId: worksheet.worksheetId }
                    : {}),
                edits: worksheet.edits,
                dirtyEdits: worksheet.dirtyEdits,
            }),
        };
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
        persisted_save_targets.set(operation.identity, operation.durableTargets);
        let conflict_overlays_authenticated = false;
        const committed = await update_file_state((current) => {
            conflict_overlays_authenticated = false;
            for (const [index, worksheet] of operation.identity.worksheets.entries()) {
                const target = operation.durableTargets[index];
                const canonical = own_pending_structural_changes(
                    pending_changes_for_sheet(
                        current.pendingEdits,
                        target.sheetIndex,
                        target.sheetName,
                        target.worksheetId,
                    ) ?? {},
                ).conflicts;
                const submitted = worksheet.structuralChanges?.conflicts ?? [];
                if (JSON.stringify(submitted) !== JSON.stringify(canonical)) {
                    return current;
                }
            }
            conflict_overlays_authenticated = true;
            let pending = current.pendingEdits;
            operation.identity.worksheets.forEach((worksheet, index) => {
                const target = operation.durableTargets[index];
                // Already sanitized: `operation.identity` is the owned operation
                // built by `parse_save_operation` after its complete dirty maps
                // passed the wire boundary.
                pending = worksheet.structuralChanges === undefined
                    ? with_pending_edits_for_sheet(
                        pending,
                        target.sheetIndex,
                        { ...worksheet.dirtyEdits },
                        target.sheetName,
                        target.worksheetId,
                    )
                    : with_pending_changes_for_sheet(
                        pending,
                        target.sheetIndex,
                        {
                            cells: { ...worksheet.dirtyEdits },
                            ...worksheet.structuralChanges,
                        },
                        target.sheetName,
                        target.worksheetId,
                    );
            });
            return { ...current, pendingEdits: pending };
        }, undefined, () => save_operation_is_current(operation));
        if (
            !conflict_overlays_authenticated
            || !committed
            || !save_operation_is_current(operation)
        ) {
            throw new Error('The save operation changed before its edits were accepted.');
        }
        notify_edit_state(committed);
    }

    async function handle_save(input: unknown): Promise<void> {
        const receiver_epoch = session.current_receiver_epoch;
        if (active_save_operation) return;
        const parsed = parse_save_operation(input);
        if (parsed.status === 'malformed') {
            if (!parsed.correlation) return;
            const lifecycle = finish_malformed_save_lifecycle(parsed.correlation);
            void post_to_receiver({
                type: 'saveResult',
                success: false,
                lifecycle,
            }, receiver_epoch);
            return;
        }
        const identity = parsed.operation;
        // The session covers the workbook, so the save names its own worksheet —
        // but the index is a caller-controlled wire number that reaches the
        // planner and the meta lookup below, so it is bounded against the live
        // workbook here. `parse_save_operation` captured the name at that index;
        // an index the workbook does not have captured no name and resolves to
        // nothing, and a reorder landing between the message and this check makes
        // the captured name resolve elsewhere — both are refusals, not saves into
        // whatever sheet now sits at the number.
        const live_sheet_count = source?.meta().sheets.length ?? 0;
        const wrong_sheet = identity.worksheets.some((worksheet) => {
            const missing_multisheet_identity = live_sheet_count > 1
                && worksheet.worksheetId === undefined
                && worksheet.sheetName === undefined;
            return worksheet.sheetIndex >= live_sheet_count
                || missing_multisheet_identity
                || save_sheet_displaced(worksheet);
        });
        if (wrong_sheet || !edit_message_is_current(identity.editSessionId)) {
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
        const expected_observation = source_observation;
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
        const history_replay_in_flight = history_replay_blocks_save();
        if (
            edit_cleanup_blocked()
            || transform_work_in_flight()
            || history_replay_in_flight
            || !editing_supported
            || !src
            || !core
            || !!src.truncationMessage
            || expected_digest === undefined
            || expected_observation === undefined
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
                    : history_replay_in_flight
                    ? 'Wait for undo or redo to finish, then save again.'
                    : 'The table view is still refreshing. Please try saving again.',
            );
            void post_to_receiver({ type: 'saveResult', success: false, lifecycle });
            return;
        }

        const save_core = core;
        let plan: SavePlan;
        try {
            plan = profile.plan_save({
                source: src,
                file_path,
                cached_formula_calculation: (request) =>
                    save_core.cached_formula_calculation(request),
                worksheets: identity.worksheets.map((worksheet) => ({
                    sheet_index: worksheet.sheetIndex,
                    edits: worksheet.edits,
                    wanted_bases: new Set(Object.keys(worksheet.dirtyEdits)),
                    dirty_edits: worksheet.dirtyEdits,
                    structural_changes: worksheet.structuralChanges,
                })),
            });
        } catch (error) {
            const active = begin_save_lifecycle(identity);
            const lifecycle = finish_save_lifecycle(active.operation, 'failed');
            const rejection = structural_save_rejection(error);
            if (rejection !== undefined) {
                void post_to_receiver({
                    type: 'saveResult',
                    success: false,
                    lifecycle,
                    rejection,
                });
                return;
            }
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
        // Read the operation's worksheet defensively: this line sits outside the
        // try below, so dereferencing a missing lookup would throw past every failure
        // path and leave the save lifecycle stuck in flight.
        let rejection: CsvSaveRejection | undefined;
        const sheet_metas = src.meta().sheets;
        for (let index = 0; index < identity.worksheets.length; index += 1) {
            const worksheet = identity.worksheets[index];
            const sheet_meta = sheet_metas[worksheet.sheetIndex];
            const validation = sheet_meta
                ? validate_dirty_bases(
                    worksheet.dirtyEdits,
                    sheet_meta.sourceRowCount,
                    (source_row, col) => plan.observed_bases[index]?.get(`${source_row}:${col}`),
                    plan.observed_rich
                        ? (source_row, col) => plan.observed_rich?.[index]?.get(`${source_row}:${col}`)
                        : undefined,
                    plan.observed_links
                        ? (source_row, col) => plan.observed_links?.[index]?.get(`${source_row}:${col}`)
                        : undefined,
                )
                : {
                    type: 'conflicts' as const,
                    keys: Object.keys(worksheet.dirtyEdits),
                    observedBases: {},
                };
            if (validation.type === 'valid') continue;
            rejection = base_validation_save_rejection(validation, index);
            break;
        }
        if (rejection) {
            // Same shape as the sibling early-returns above: a begin/finish pair so
            // the webview sees a terminal 'failed' lifecycle for this exact
            // operation and restores the precise dirty map it submitted.
            const active = begin_save_lifecycle(identity);
            const lifecycle = finish_save_lifecycle(active.operation, 'failed');
            // The renderer owns this expected condition: it can show the original,
            // current and pending values together and offer a per-cell discard.
            // A host warning would duplicate that notice and becomes a modal dialog
            // in the desktop app, turning an informational event into an alarm.
            void post_to_receiver({
                type: 'saveResult',
                success: false,
                lifecycle,
                rejection,
            });
            return;
        }

        const durable_targets = Object.freeze(identity.worksheets.map((worksheet) => {
            const sheet_meta = sheet_metas[worksheet.sheetIndex];
            return Object.freeze<WorksheetTarget>({
                sheetIndex: worksheet.sheetIndex,
                ...(worksheet.sheetName !== undefined
                    ? { sheetName: worksheet.sheetName }
                    : {}),
                ...(worksheet.worksheetId !== undefined || sheet_meta?.worksheetId !== undefined
                    ? { worksheetId: worksheet.worksheetId ?? sheet_meta?.worksheetId }
                    : {}),
            });
        }));
        const operation: CsvSaveHostOperation = {
            identity,
            durableTargets: durable_targets,
            phase: 'preparing',
        };
        active_save_operation = operation;
        // Installed synchronously: later append/settlement/publication authority
        // work queues behind this Save until its final authority use is complete.
        const save_append_authority = fence_append_admission_authority();
        const active_lifecycle = begin_save_lifecycle(identity);
        void post_to_receiver({
            type: 'saveOperationStarted',
            lifecycle: active_lifecycle,
        }, receiver_epoch);

        // Produced below, once the bytes on disk have been verified against the
        // acknowledged digest: an xlsx save splices into exactly those bytes, so
        // it cannot be built before we know which bytes they are.
        let saved_bytes: Uint8Array;
        let saved_digest: string;
        let save_receipt = plan.receipt;
        const persisted_append_snapshots = new Map<
            string,
            SavedAppendedRowSnapshot
        >();
        let post_save_reservation: { cancel(): void } | undefined;
        try {
            await pending_edit_writes.catch(() => {});
            await save_append_authority.ready;
            if (!save_may_continue(operation)) return;
            if (identity.worksheets.some((worksheet, index) => (
                worksheet.structuralChanges !== undefined
                && !save_structural_claim_is_authorized(
                    identity.editSessionId,
                    operation.durableTargets[index],
                    worksheet.structuralChanges,
                )
            ))) {
                throw new Error('The pending-row authority changed before Save began.');
            }
            await persist_accepted_save(operation);
            operation.phase = 'accepted';

            // Shared refusal path: the adopted-source check, full verification,
            // and final pre-write re-stat must report the retry identically, so a
            // detected race never surfaces as a generic "Failed to save" error.
            const refuse_as_external_change = async (): Promise<void> => {
                show_owner_warning(
                    'The file changed before the save could finish. No pending edits were written; try saving again.',
                );
                if (!disposed) await refresh_panel_source(true, 'recovery');
                if (!save_operation_owns_lifecycle(operation)) return;
                finish_save_failure(operation);
            };

            const current_stat = await host.fs.stat(uri);
            if (!save_may_continue(operation)) return;
            // The size setting admits new source loads; save operates on the exact
            // source already adopted. Reject a changed physical snapshot before a
            // potentially much larger replacement is read into memory.
            if (`${current_stat.mtime}:${current_stat.size}` !== expected_observation.fingerprint) {
                await refuse_as_external_change();
                return;
            }

            const current_raw = await host.fs.read_file(uri);
            if (!save_may_continue(operation)) return;

            const verified_stat = await host.fs.stat(uri);
            if (!save_may_continue(operation)) return;
            const snapshot_changed = current_stat.mtime !== verified_stat.mtime
                || current_stat.size !== verified_stat.size;

            if (
                snapshot_changed
                || content_digest(current_raw) !== expected_digest
                || source_authority.authorityRevision !== expected_authority
                || expected_authority !== file_coordinator.authority().authorityRevision
            ) {
                await refuse_as_external_change();
                return;
            }

            // `current_raw` is now known to be the bytes this session parsed, so
            // it is the correct base for a splice as well as for the comparison
            // above. A CSV plan ignores it and re-serializes from the source.
            saved_bytes = plan.produce(current_raw);
            if (
                save_receipt !== undefined
                && save_receipt.appendedRows.length > 0
                && file_path.toLowerCase().endsWith('.xlsx')
            ) {
                // The XLSX writer canonicalizes values (for example `1.0` to a
                // numeric `1`) and external links before they reach disk. A
                // receipt derived from renderer input would then reject its own
                // untouched output during cross-save Undo. Parse the exact bytes
                // we are about to write and fingerprint that physical result.
                const current_state = await read_file_state(false);
                const persisted_source = await profile.build_source(
                    saved_bytes,
                    file_path,
                    current_state.state as PerFileState,
                );
                try {
                    const appendedRows = save_receipt.appendedRows.map((assignment) => {
                        const sheet = persisted_source.meta().sheets[assignment.sheetIndex];
                        if (!sheet) throw new Error('A saved row receipt lost its worksheet.');
                        const physical_format = capture_xlsx_append_row_format(
                            saved_bytes,
                            assignment.sheetIndex,
                            assignment.sourceRow + 1,
                            sheet.columnCount,
                            sheet.excelFirstRowHeader?.active === true
                                ? sheet.excelFirstRowHeader.sourceRow
                                : undefined,
                        );
                        const inherited_viewer_height = assignment.savedRow?.format.kind === 'xlsx'
                            ? assignment.savedRow.format.viewerRowHeight
                            : undefined;
                        const format = inherited_viewer_height === undefined
                            ? physical_format
                            : Object.freeze({
                                ...physical_format,
                                viewerRowHeight: inherited_viewer_height,
                            });
                        const cells = source_row_cells_for_fingerprint(
                            persisted_source,
                            assignment.sheetIndex,
                            assignment.sourceRow,
                        );
                        const savedRow = persisted_saved_row_snapshot(
                            assignment.savedRow ?? { cells: assignment.savedCells ?? {} },
                            format,
                            cells,
                        );
                        persisted_append_snapshots.set(assignment.pendingRowId, savedRow);
                        return Object.freeze({
                            ...assignment,
                            savedCells: savedRow.cells,
                            savedRow,
                            savedFingerprint: saved_row_snapshot_fingerprint(savedRow),
                        });
                    });
                    save_receipt = Object.freeze({
                        appendedRows: Object.freeze(appendedRows),
                        removedSourceRows: save_receipt.removedSourceRows,
                    });
                } finally {
                    persisted_source.close();
                }
            }
            saved_digest = content_digest(saved_bytes);

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
                if (!save_operation_owns_lifecycle(operation)) return;
                await refuse_as_external_change();
                return;
            }
            if (!save_may_continue(operation)) return;
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
                let highlights = rebase_cell_highlight_digest(
                    current.cellHighlights,
                    saved_digest,
                );
                const rowHeights = [...(current.rowHeights ?? [])];
                const prospective_meta: WorkbookMeta = {
                    ...src.meta(),
                    sheets: src.meta().sheets.map((sheet, sheetIndex) => {
                        const removed = save_receipt?.removedSourceRows.find(
                            (entry) => entry.sheetIndex === sheetIndex,
                        )?.sourceRows.length ?? 0;
                        const appended = save_receipt?.appendedRows.filter(
                            (entry) => entry.sheetIndex === sheetIndex,
                        ).length ?? 0;
                        const count = sheet.sourceRowCount - removed + appended;
                        return { ...sheet, sourceRowCount: count, rowCount: count };
                    }),
                };
                for (const [worksheet_index, worksheet] of identity.worksheets.entries()) {
                    const structural = worksheet.structuralChanges;
                    if (!structural) continue;
                    const receipt_target = operation.durableTargets[worksheet_index] ?? worksheet;
                    const assignments = save_receipt?.appendedRows.filter((assignment) =>
                        worksheet_target_matches(assignment, receipt_target)) ?? [];
                    const removed = save_receipt?.removedSourceRows.find((entry) =>
                        worksheet_target_matches(entry, receipt_target))?.sourceRows ?? [];
                    const patch: Record<string, CellHighlightColor | null> = {};
                    const existing_highlights = highlights?.sheets[worksheet.sheetIndex]?.cells;
                    if (existing_highlights && removed.length > 0) {
                        const removed_set = new Set(removed);
                        for (const key of Object.keys(existing_highlights)) {
                            const coordinate = parse_cell_key(key);
                            if (coordinate && removed_set.has(coordinate.sourceRow)) {
                                patch[key] = null;
                            }
                        }
                    }
                    // Removal owns the old coordinate even when this save replaces
                    // it with an appended row. Clear all old heights before applying
                    // the replacement's explicit or template height below.
                    if (removed.length > 0 && rowHeights[worksheet.sheetIndex]) {
                        const sheet_heights = { ...rowHeights[worksheet.sheetIndex] };
                        for (const row of removed) delete sheet_heights[row];
                        rowHeights[worksheet.sheetIndex] = Object.keys(sheet_heights).length > 0
                            ? sheet_heights
                            : undefined;
                    }
                    const templates = new Map(structural.formatTemplates.map(
                        (template) => [template.id, template.format],
                    ));
                    for (const assignment of assignments) {
                        const row = structural.appendedRows.find(
                            (candidate) => candidate.id === assignment.pendingRowId,
                        );
                        if (!row) throw new Error('A saved row receipt has no pending source.');
                        for (const [column, color] of Object.entries(row.highlights ?? {})) {
                            patch[`${assignment.sourceRow}:${column}`] = color;
                        }
                        const format = templates.get(row.formatTemplateId);
                        const height = row.viewerRowHeight
                            ?? (format?.kind === 'xlsx' ? format.viewerRowHeight : undefined);
                        if (height !== undefined) {
                            const sheet_heights = { ...(rowHeights[worksheet.sheetIndex] ?? {}) };
                            sheet_heights[assignment.sourceRow] = height;
                            rowHeights[worksheet.sheetIndex] = sheet_heights;
                        }
                    }
                    if (Object.keys(patch).length > 0) {
                        highlights = apply_cell_highlight_patch(
                            highlights,
                            { sheetIndex: worksheet.sheetIndex, cells: patch },
                            prospective_meta,
                            saved_digest,
                        );
                    }
                }
                const heights_unchanged = JSON.stringify(current.rowHeights ?? [])
                    === JSON.stringify(rowHeights);
                if (
                    cell_highlight_states_equal(current.cellHighlights, highlights)
                    && heights_unchanged
                ) {
                    rebase_was_noop = true;
                    return current;
                }
                return {
                    ...current,
                    cellHighlights: highlights,
                    rowHeights,
                };
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
            commit_saved_append_authorities(
                operation,
                save_receipt,
                persisted_append_snapshots,
            );
        } catch (error) {
            // A disposed failure releases the edit session from this catch. Do
            // not let that release wait on the Save's own authority fence; the
            // finally below would otherwise be unreachable.
            save_append_authority.release();
            if (active_save_operation !== operation) return;
            active_save_operation = undefined;
            post_save_reservation?.cancel();
            const lifecycle = finish_save_lifecycle(identity, 'failed');
            if (disposed) {
                await release_edit_session(identity.editSessionId);
                delete_shared_edit_state_if_unused();
                return;
            }
            const rejection = structural_save_rejection(error);
            if (rejection !== undefined) {
                void post_to_receiver({
                    type: 'saveResult',
                    success: false,
                    lifecycle,
                    rejection,
                    basesValidated: true,
                });
                return;
            }
            show_owner_error(
                `Failed to save: ${error instanceof Error ? error.message : String(error)}`,
            );
            void post_to_receiver({
                type: 'saveResult',
                success: false,
                lifecycle,
                basesValidated: true,
            });
            return;
        } finally {
            save_append_authority.release();
        }

        // writeFile completed: fence later publications synchronously, then let
        // every sibling-sheet publication admitted before that boundary finish
        // under the session/token authority it crossed with. Cleanup cannot clear
        // ownership first: doing so makes those writes abort their own CAS checks.
        const write_fence = fence_edit_session_writes(identity.editSessionId);
        if (write_fence) {
            try {
                await write_fence.admittedWrites;
            } catch (error) {
                log_sanitized_failure(
                    'Failed to settle admitted worksheet edits before save cleanup',
                    error,
                );
            }
        }

        // Atomically prevent every attachment from claiming or projecting edits
        // until the durable pending-state clear finishes.
        const succeeded_lifecycle = finish_save_lifecycle(identity, 'succeeded');
        let cleanup_operation = begin_edit_cleanup(
            identity.editSessionId,
            operation,
            write_fence?.release,
        );
        if (!cleanup_operation) {
            cleanup_operation = Symbol(file_key);
            active_save_operation = undefined;
            active_edit_session_id = undefined;
            if (file_edit_state) {
                file_edit_state.phase = {
                    type: 'cleanupPending',
                    operation: cleanup_operation,
                    scope: {
                        type: 'worksheets',
                        targets: operation.durableTargets,
                    },
                };
            }
            console.error('CSV save lost edit ownership after writeFile');
        }

        void post_to_receiver({
            type: 'saveResult',
            success: true,
            lifecycle: succeeded_lifecycle,
            ...(save_receipt === undefined ? {} : { receipt: save_receipt }),
        });
        notify_edit_state();

        void refresh_subscription.request('postSave', saved_digest).catch((error) => {
            if (disposed) return;
            log_sanitized_failure('Post-save refresh request failed (file was written)', error);
            show_owner_warning(
                'The file was saved, but Table Viewer could not refresh the table view.',
            );
        });

        void clear_pending_edits({
            type: 'worksheets',
            targets: operation.durableTargets,
        }).then((snapshot) => {
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
        const transform_admission: TransformAdmission = editing_supported
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
            if (editing_supported) {
                finish_transform_admission(transform_admission.operation);
            }
        }
    }

    const receive_webview_message = async (msg: WebviewMessage): Promise<void> => {
        options.integrationTestPort?.on_webview_message(msg);
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
                for (const [requestId, reservation] of [...row_admission_reservations]) {
                    settle_row_admission({
                        type: 'settleRowAdmission',
                        requestId,
                        editSessionId: reservation.editSessionId,
                        accepted: false,
                    });
                }
                active_edit_session_request = undefined;
                cancel_edit_claim(active_edit_claim);
                // A reloaded renderer has no history — it is session-scoped and
                // died with the old one — so there is nothing left that could
                // spend a lease or read a retained answer. Cleared rather than
                // invalidated: retaining terminal records for a webview that no
                // longer remembers asking would only hold memory.
                replay_leases.clear();
                replay_preparation_in_flight = false;
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

                        const transform_admission: TransformAdmission = editing_supported
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
                                sheets,
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
                            if (editing_supported) {
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
                if (session.acknowledged_current()) flush_sheet_selections();
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
                const installed_transform = core.installed_transform_state(
                    msg.sheetIndex,
                );
                if (installed_transform !== undefined) {
                    source.set_hidden_rows(
                        msg.sheetName,
                        installed_transform.hiddenRows,
                    );
                }
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
                const planning_input = command_source.planning_input();
                const result = await file_coordinator.commit_excel_header({
                    requestId: msg.requestId,
                    sheetIndex: msg.sheetIndex,
                    sheetName: msg.sheetName,
                    override: msg.enabled ? 'on' : 'off',
                    originToken: excel_header_subscriber_token,
                    expectedPhysicalRevision: expected_physical_revision,
                    expectedPhysicalDigest: expected_physical_digest,
                    planningInput: planning_input,
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
                    ) {
                        const planning_sheet = planning_input.sheets[msg.sheetIndex];
                        console.warn('Excel header planning rejected a current request', {
                            requestId: msg.requestId,
                            sheetIndex: msg.sheetIndex,
                            requestedMode: msg.enabled ? 'on' : 'off',
                            requestedHeaderRow: msg.headerRow ?? null,
                            clearHiddenRows: msg.unhideAll === true,
                            installedTransform: installed_transform !== undefined,
                            installedHiddenRowCount:
                                installed_transform?.hiddenRows?.length ?? null,
                            plannedManualHeaderSourceRow:
                                planning_sheet?.manualHeaderSourceRow ?? null,
                            activeHeaderSourceRow: header.sourceRow ?? null,
                        });
                        schedule_header_refresh();
                    }
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
                // The sheet the user pressed Edit on. Editing is worksheet-scoped,
                // so the request names its sheet and every answer echoes it back:
                // the webview keeps one store per sheet and must not apply a grant
                // to the wrong one.
                // A request that names no sheet means the first one: single-sheet
                // sources (CSV/TSV) have nothing else to mean, and a webview from
                // before worksheet editing sends the field not at all.
                const requested_sheet_index = msg.sheetIndex ?? 0;
                // A wire number, so bounded here rather than trusted: it reaches
                // the meta lookups downstream, and a session on a sheet the workbook
                // does not have is not a session at all. New renderers also stamp the
                // worksheet identity they displayed. Validate that stamp immediately,
                // so a reorder while this message waited in the queue cannot retarget
                // the request to the new occupant of the stale index.
                const index_in_range = Number.isSafeInteger(requested_sheet_index)
                    && requested_sheet_index >= 0
                    && requested_sheet_index < (source?.meta().sheets.length ?? 0);
                const live_requested_sheet = index_in_range
                    ? source?.meta().sheets[requested_sheet_index]
                    : undefined;
                const wire_identity_matches = msg.worksheetId !== undefined
                    ? live_requested_sheet?.worksheetId === msg.worksheetId
                    : msg.sheetName !== undefined
                        ? live_requested_sheet?.name === msg.sheetName
                        : true;
                const requested_sheet_exists = live_requested_sheet !== undefined
                    && wire_identity_matches;
                // Preserve name-only and index-only compatibility. An ID-bearing
                // request follows the ID-first rule; a legacy name-only request never
                // gains an ID, while an old index-only request captures the live
                // identity here so movement during the awaits below is still refused.
                const requested_sheet_name = msg.sheetName ?? live_requested_sheet?.name;
                const requested_worksheet_id = msg.worksheetId ?? (
                    msg.sheetName === undefined
                        ? live_requested_sheet?.worksheetId
                        : undefined
                );
                if (edit_admission_closed || !requested_sheet_exists) {
                    void post_to_receiver({
                        type: 'editSessionResult',
                        requestId: msg.requestId,
                        granted: false,
                        sheetIndex: requested_sheet_index,
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
                    && editing_supported
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
                        sheetIndex: requested_sheet_index,
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
                    && editing_supported
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
                // The workbook moved under the request. Refused rather than followed to
                // wherever the name went: this is the answer to a button press, and by
                // now the grid the user pressed it on is already being replaced by the
                // reordered one. Refusing means pressing Edit again works; retargeting
                // means a granted session on a worksheet they did not choose.
                //
                // The session itself is workbook-scoped, so a request on any sheet
                // of a workbook this panel already holds a session for is the same
                // session — granted, with that sheet's slot projected below.
                const sheet_moved = requested_worksheet_id !== undefined
                    ? worksheet_id_at(requested_sheet_index) !== requested_worksheet_id
                    : requested_sheet_name !== undefined
                        && sheet_name_at(requested_sheet_index) !== requested_sheet_name;
                const granted_sheet_index = requested_sheet_index;
                const granted = can_edit
                    && !sheet_moved
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
                if (granted && active_edit_session_id) {
                    set_active_edit_session_target(active_edit_session_id, {
                        sheetIndex: granted_sheet_index,
                        sheetName: sheet_name_at(granted_sheet_index),
                        worksheetId: worksheet_id_at(granted_sheet_index),
                    });
                }
                const reconciled_edit_state = granted && edit_state && source
                    ? reconciled_against(edit_state, source)
                    : edit_state;
                if (reconciled_edit_state) update_session_state_material(reconciled_edit_state);
                // The reason half of the same question `can_edit` asked: an installed
                // sort or filter is not a denial, because editing under one is
                // supported and the rows stay exactly where they are. Only work in
                // flight refuses, and it refuses transiently.
                const denied_by_transform = editing_supported
                    && !!source
                    && !source.truncationMessage
                    && !may_begin_editing();
                // `read_file_state` hands back the durable leaf as written, and
                // the leaf is positional: a workbook reordered since the slots
                // were committed leaves another worksheet's draft sitting at the
                // granted index. Every write-path reader reconciles through
                // `normalize_host_state` before trusting a position; this read
                // path must do the same, or the grant projects a foreign draft
                // into the requested sheet's store.
                const reconciled_slots = granted
                    ? reconcile_pending_edit_sheets(
                        (reconciled_edit_state?.state as PerFileState | undefined)?.pendingEdits,
                        source?.meta().sheets ?? [],
                    )
                    : undefined;
                const pendingEdits = granted
                    ? pending_edits_for_current_session(
                        pending_edits_for_sheet(
                            reconciled_slots,
                            granted_sheet_index,
                            sheet_name_at(granted_sheet_index),
                            worksheet_id_at(granted_sheet_index),
                        ),
                        {
                            sheetIndex: granted_sheet_index,
                            sheets: source?.meta().sheets,
                            slots: reconciled_slots,
                        },
                    )
                    : undefined;
                const durable_slot = granted
                    ? pending_changes_for_sheet(
                        reconciled_slots,
                        granted_sheet_index,
                        sheet_name_at(granted_sheet_index),
                        worksheet_id_at(granted_sheet_index),
                    )
                    : undefined;
                const pendingChanges = granted ? Object.freeze({
                    sheetIndex: granted_sheet_index,
                    ...(sheet_name_at(granted_sheet_index) === undefined
                        ? {}
                        : { sheetName: sheet_name_at(granted_sheet_index) }),
                    ...(worksheet_id_at(granted_sheet_index) === undefined
                        ? {}
                        : { worksheetId: worksheet_id_at(granted_sheet_index) }),
                    cells: Object.freeze(Object.fromEntries(
                        Object.entries(pendingEdits ?? {}).map(([key, entry]) => [
                            key,
                            typeof entry === 'string'
                                ? Object.freeze({ value: entry, base: '' })
                                : entry,
                        ]),
                    )),
                    ...own_pending_structural_changes(durable_slot ?? {}),
                }) : undefined;
                if (granted && active_edit_session_id && pendingChanges) {
                    const target: WorksheetTarget = {
                        sheetIndex: granted_sheet_index,
                        ...(pendingChanges.sheetName === undefined
                            ? {}
                            : { sheetName: pendingChanges.sheetName }),
                        ...(pendingChanges.worksheetId === undefined
                            ? {}
                            : { worksheetId: pendingChanges.worksheetId }),
                    };
                    const key = append_ledger_key(active_edit_session_id, target);
                    const ledger = append_admission_ledgers.get(key) ?? {
                        ownedRowIds: new Set<string>(),
                        templateIdByRowId: new Map<string, string>(),
                        reservedRowIds: new Map<string, number>(),
                        unsettledRequestByRowId: new Map<string, string>(),
                        sourceGeneration: core?.source_generation ?? 0,
                    };
                    for (const row of pendingChanges.appendedRows) {
                        ledger.ownedRowIds.add(row.id);
                        ledger.templateIdByRowId.set(row.id, row.formatTemplateId);
                    }
                    for (const template of pendingChanges.formatTemplates) {
                        append_admission_template_authorities.remember(
                            ledger_template_authority_owner(key),
                            template,
                        );
                    }
                    ledger.appendBasis = pendingChanges.appendBasis;
                    for (const removal of pendingChanges.tailRemovals) {
                        seed_durable_tail_removal_authority(target, removal);
                    }
                    append_admission_ledgers.set(key, ledger);
                }
                if (!request_is_current()) return;
                active_edit_session_request = undefined;
                void post_to_receiver({
                    type: 'editSessionResult',
                    requestId: request.requestId,
                    granted,
                    // Echoes the sheet asked about: the webview keeps one store per
                    // sheet and must not apply a grant to the wrong one.
                    sheetIndex: granted_sheet_index,
                    ...(granted && active_edit_session_id
                        ? { editSessionId: active_edit_session_id }
                        : {}),
                    ...(granted
                        ? { diffOnByDefault: host.config.diff_on_by_default() }
                        : {}),
                    ...(pendingEdits ? { pendingEdits } : {}),
                    ...(pendingChanges && (
                        pendingChanges.appendedRows.length > 0
                        || pendingChanges.tailRemovals.length > 0
                        || pendingChanges.formatTemplates.length > 0
                        || pendingChanges.conflicts.length > 0
                        || pendingChanges.appendBasis !== undefined
                    ) ? { pendingChanges } : {}),
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
            case 'retainedSavedAppendAuthoritiesChanged': {
                if (!Array.isArray(msg.authorities)) return;
                const retained = new Set<string>();
                const retained_pending = new Set<string>();
                let retained_count = 0;
                let retained_pending_count = 0;
                for (const raw of msg.authorities) {
                    if (!is_plain_record(raw) || !Array.isArray(raw.appendHistoryIds)) return;
                    const requested_target = sanitized_wire_worksheet_target(raw);
                    const target = requested_target === undefined
                        ? undefined
                        : canonical_worksheet_target(requested_target);
                    if (target === undefined || target.sheetIndex !== requested_target!.sheetIndex) {
                        return;
                    }
                    for (const id of raw.appendHistoryIds) {
                        retained_count += 1;
                        if (
                            retained_count > MAX_SAVED_APPEND_AUTHORITIES
                            || typeof id !== 'string'
                            || id.length === 0
                            || id.length > 256
                        ) return;
                        const key = saved_append_authority_key(target, id);
                        if (key === undefined) return;
                        retained.add(key);
                    }
                    if (raw.pendingRowIds !== undefined && !Array.isArray(raw.pendingRowIds)) {
                        return;
                    }
                    for (const id of raw.pendingRowIds ?? []) {
                        retained_pending_count += 1;
                        if (
                            retained_pending_count > MAX_SAVED_APPEND_AUTHORITIES
                            || typeof id !== 'string'
                            || id.length === 0
                            || id.length > 128
                        ) return;
                        retained_pending.add(pending_append_history_key(
                            worksheet_target_key(target),
                            id,
                        ));
                    }
                }
                const current_sheets = source?.meta().sheets ?? [];
                for (const [key, authority] of saved_append_authorities) {
                    // A retention projection can only speak for worksheets in
                    // the renderer's current snapshot. Keep a known capability
                    // while its worksheet is temporarily absent; if that same
                    // identity returns, the next projection can retire it or
                    // keep it. The map remains subject to its hard count/byte
                    // limits while a permanently removed sheet stays absent.
                    if (
                        !retained.has(key)
                        && worksheet_target_index(current_sheets, authority.worksheet)
                            !== undefined
                    ) forget_saved_append_authority(key);
                }
                retained_pending_append_keys.clear();
                for (const key of retained_pending) retained_pending_append_keys.add(key);
                for (const [target_key, authorities] of retained_pending_append_authorities.entries()) {
                    for (const id of [...authorities.keys()]) {
                        if (!retained_pending.has(pending_append_history_key(target_key, id))) {
                            retained_pending_append_authorities.forget(target_key, id);
                        }
                    }
                }
                return;
            }
            case 'requestAppendRows': {
                const receiver_epoch = session.current_receiver_epoch;
                // Two rapid Enter/paste gestures receive IDs in request order
                // even when format capture crosses asynchronous file/state reads.
                const prior = append_admission_tails.get(
                    APPEND_ADMISSION_AUTHORITY_TAIL,
                ) ?? Promise.resolve();
                const admitted = prior.catch(() => undefined).then(async () => {
                    try {
                        await admit_append_rows(msg, receiver_epoch);
                    } catch (error) {
                        settle_row_admission({
                            type: 'settleRowAdmission',
                            requestId: msg.requestId,
                            editSessionId: msg.editSessionId,
                            accepted: false,
                        });
                        row_admission_request_ids.delete(msg.requestId);
                        log_sanitized_failure('Failed to admit appended rows', error);
                        await post_to_receiver({
                            type: 'appendRowsResult',
                            requestId: msg.requestId,
                            sourceGeneration: msg.sourceGeneration,
                            granted: false,
                            reason: 'Table Viewer could not prepare the appended rows.',
                        }, receiver_epoch);
                    }
                });
                append_admission_tails.set(APPEND_ADMISSION_AUTHORITY_TAIL, admitted);
                await admitted;
                if (append_admission_tails.get(APPEND_ADMISSION_AUTHORITY_TAIL) === admitted) {
                    append_admission_tails.delete(APPEND_ADMISSION_AUTHORITY_TAIL);
                }
                return;
            }
            case 'settleRowAdmission': {
                // Settlement mutates the same reservation, ledger and template
                // authority that publication snapshots before its durable CAS.
                // Queue it behind that publication so neither transition can
                // overwrite the other's authority state.
                const prior = append_admission_tails.get(
                    APPEND_ADMISSION_AUTHORITY_TAIL,
                ) ?? Promise.resolve();
                const settled = prior.catch(() => undefined).then(() => {
                    settle_row_admission(msg);
                });
                append_admission_tails.set(APPEND_ADMISSION_AUTHORITY_TAIL, settled);
                await settled;
                if (append_admission_tails.get(APPEND_ADMISSION_AUTHORITY_TAIL) === settled) {
                    append_admission_tails.delete(APPEND_ADMISSION_AUTHORITY_TAIL);
                }
                return;
            }
            case 'validateTailRemovalReplay':
                await validate_tail_removal_replay(msg);
                return;
            case 'requestRestoreSavedRows': {
                const receiver_epoch = session.current_receiver_epoch;
                const prior = append_admission_tails.get(
                    APPEND_ADMISSION_AUTHORITY_TAIL,
                ) ?? Promise.resolve();
                const admitted = prior.catch(() => undefined).then(async () => {
                    try {
                        await admit_saved_row_restoration(msg, receiver_epoch);
                    } catch (error) {
                        settle_row_admission({
                            type: 'settleRowAdmission',
                            requestId: msg.requestId,
                            editSessionId: msg.editSessionId,
                            accepted: false,
                        });
                        row_admission_request_ids.delete(msg.requestId);
                        log_sanitized_failure('Failed to restore saved appended rows', error);
                        await post_to_receiver({
                            type: 'restoreSavedRowsResult',
                            requestId: msg.requestId,
                            sourceGeneration: msg.sourceGeneration,
                            granted: false,
                            reason: 'Table Viewer could not restore the saved rows.',
                        }, receiver_epoch);
                    }
                });
                append_admission_tails.set(APPEND_ADMISSION_AUTHORITY_TAIL, admitted);
                await admitted;
                if (append_admission_tails.get(APPEND_ADMISSION_AUTHORITY_TAIL) === admitted) {
                    append_admission_tails.delete(APPEND_ADMISSION_AUTHORITY_TAIL);
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
                const settle_resize = (applied: boolean): void => {
                    if (
                        message.requestId === undefined
                        || disposed
                        || session.current_receiver_epoch !== receiver_epoch
                    ) return;
                    void post_to_receiver({
                        type: 'rowHeightsChanged',
                        requestId: message.requestId,
                        sheetIndex: message.sheetIndex,
                        applied,
                        sourceGeneration: core?.source_generation
                            ?? message.sourceGeneration,
                    }, receiver_epoch);
                };
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
                if (!core || !source || !resize_is_current()) {
                    settle_resize(false);
                    return;
                }
                if (!source.meta().sheets[message.sheetIndex]) {
                    settle_resize(false);
                    return;
                }
                if (!Number.isFinite(message.height)) {
                    settle_resize(false);
                    return;
                }
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
                    ) {
                        settle_resize(false);
                        return;
                    }
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
                if (requested_rows === 0) {
                    settle_resize(false);
                    return;
                }
                if (requested_rows > MAX_PERSISTED_ROW_HEIGHTS) {
                    show_owner_warning(ROW_HEIGHT_LIMIT_WARNING);
                    settle_resize(false);
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
                    settle_resize(false);
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
                    settle_resize(true);
                } else {
                    settle_resize(false);
                }
                return;
            }
            case 'setTransform': {
                await handle_transform_message(msg);
                return;
            }
            case 'releaseEditSession':
                if (editing_supported && edit_message_is_current(msg.editSessionId)) {
                    active_save_dialog_request = undefined;
                    await release_edit_session(msg.editSessionId);
                    if (!disposed) await refresh_session_state_material(false);
                }
                return;
            case 'discardEditSession':
                if (editing_supported && edit_message_is_current(msg.editSessionId)) {
                    const writing = active_save_operation?.phase === 'writing'
                        && active_save_operation.identity.editSessionId === msg.editSessionId;
                    if (writing) return;
                    active_save_dialog_request = undefined;
                    const operation = begin_edit_cleanup(msg.editSessionId);
                    if (!operation) return;
                    notify_edit_state();
                    // Acknowledged either way, because a discard is undoable and
                    // undoing one has to acquire a NEW session: until cleanup
                    // settles the host refuses `requestEditSession`, so an undo in
                    // that window would fail for a reason about timing rather than
                    // about the document. The renderer waits for this rather than
                    // racing it.
                    const acknowledge = (cleared: boolean): void => {
                        void post_to_receiver({
                            type: 'discardEditSessionResult',
                            editSessionId: msg.editSessionId,
                            cleared,
                        });
                    };
                    try {
                        // The discard ends the workbook-scoped session, so every
                        // live sheet's slot goes at once — the one dialog the user
                        // confirmed covers them all.
                        const snapshot = await clear_pending_edits({ type: 'workbook' });
                        finish_edit_cleanup(operation, true, snapshot);
                        if (!disposed) update_session_state_material(snapshot, false);
                        acknowledge(true);
                    } catch (error) {
                        finish_edit_cleanup(operation, false);
                        // A failed clear leaves the host `uncertain` and editing
                        // disabled for the file, so undo has nothing to re-enter.
                        acknowledge(false);
                        log_sanitized_failure('Failed to clear discarded CSV edits', error);
                        show_owner_warning(
                            'Table Viewer could not clear the discarded edit state. Editing remains disabled for this file.');
                    }
                }
                return;
            case 'showWarning':
                host.ui.show_warning(msg.message);
                return;
            case 'cancelCompare': {
                if (!compare_mode || compare_alignment_cancelled) return;
                compare_alignment_cancelled = true;
                await options.requestClose?.();
                return;
            }
            case 'openExternal': {
                // Authoritative validation: the webview also validates for UX,
                // but a compromised or buggy renderer must not be able to hand
                // an arbitrary string to the OS opener.
                const url = parse_http_external_url(msg.url);
                if (url === null) {
                    host.ui.show_warning(
                        'Table Viewer blocked a link that is not a valid http(s) URL.');
                    return;
                }
                host.ui.open_external(url);
                return;
            }
            case 'openCsvRowLimitSetting':
                await host.ui.open_setting('csvMaxRows');
                return;
            case 'resolveLfsObject': {
                // Modelled on `loadAllCsvRows` below: a banner action that
                // changes what the next build will read, then re-runs the
                // ordinary load path so the real table arrives through the
                // same currency checks as any other refresh.
                //
                // Every received request is settled with `lfsResolveEnded`,
                // including the ones refused at the door: the renderer set its
                // "Downloading…" state when it asked, and this response — not
                // a snapshot — is what clears it. Captured before the first
                // await and epoch-gated so a webview that reloaded mid-resolve
                // is not handed an acknowledgement for a request its
                // replacement never made.
                const resolve_receiver_epoch = session.current_receiver_epoch;
                try {
                    if (!unresolved_lfs || lfs_resolve_in_flight) return;
                    const lfs = host.gitLfs;
                    if (!lfs) return;
                    lfs_resolve_in_flight = true;
                    // One click, both sides — and one delivery. A comparison
                    // has two pointers, the modified side and the version it
                    // is compared against, and each is a separate object with
                    // its own fetch. Resolving only the one the banner happens
                    // to name leaves the user looking at a second,
                    // differently-worded banner, which reads as the first
                    // download having half-failed rather than as there being
                    // two.
                    //
                    // Both objects are discovered up front, by reading what
                    // each side reads, rather than by rebuilding between
                    // fetches. A rebuild delivers a snapshot, and a snapshot
                    // delivered half-resolved flashes the window through an
                    // undiffed file carrying a second Download button on the
                    // way to the comparison the user actually asked for.
                    //
                    // The inner `finally` clears only the in-flight flag, and
                    // only for the resolve that set it: a refused duplicate
                    // returned above, before the flag, so its settlement in
                    // the outer `finally` cannot release a resolve it never
                    // owned.
                    try {
                    const targets = await lfs_resolve_targets(unresolved_lfs);
                    if (disposed) return;
                    /** Whether the panel has moved on to an object this resolve
                     *  never set out to fetch — landing an outcome on it would
                     *  attach the failure to the wrong pointer. Compared by
                     *  side and oid rather than by identity, because an
                     *  intervening delivery rebuilds the source and records the
                     *  same pointer as a fresh object, so identity would reject
                     *  every outcome for the compare-original side, whose
                     *  record is rewritten on every build. */
                    const superseded = (): boolean => {
                        const current = unresolved_lfs;
                        return current !== undefined && !targets.some(
                            (candidate) => candidate.side === current.side
                                && candidate.oid === current.oid,
                        );
                    };
                    // Panel-level policy, not per-target: which operation a
                    // side needs depends on what *this panel* reads.
                    const main_reads_working_tree = uri.scheme === 'file';
                    for (const target of targets) {
                        if (disposed || superseded()) return;
                        // Which side decides the operation, and they are not
                        // interchangeable. A working-tree pointer is fixed on
                        // disk by `pull`; the original side has no disk state
                        // to fix, so its object is smudged into memory for this
                        // comparison. The fetched bytes are carried out of the
                        // branch rather than read off the outcome afterwards,
                        // because only the smudge outcome has any — the side
                        // and the shape of the result correspond, and this
                        // keeps that visible.
                        let fetched: Uint8Array | undefined;
                        let outcome: GitLfsResolveOutcome;
                        // Which operation repairs *this* side's read. `pull`
                        // rewrites the working tree, so it only helps a side
                        // that reads the working tree. A comparison's modified
                        // side can itself be a `git:` revision, and then `pull`
                        // "succeeds" against a working-tree file the panel
                        // never reads while the next read returns the pointer
                        // again — which is exactly how a real staged-vs-HEAD
                        // diff of an LFS file made this button appear to do
                        // nothing, over and over.
                        // A port that throws rather than returning a failure
                        // would otherwise skip the failure delivery below,
                        // leaving a banner with no explanation and no way back
                        // to a retry button.
                        try {
                            if (target.side === 'file' && main_reads_working_tree) {
                                outcome = await lfs.pull(uri);
                            } else {
                                const smudged = await lfs.smudge(
                                    target.side === 'file'
                                        ? uri
                                        : compare_original_uri ?? uri,
                                    { oid: target.oid, size: target.size },
                                );
                                if (smudged.type === 'resolved') fetched = smudged.content;
                                outcome = smudged.type === 'resolved'
                                    ? { type: 'resolved' }
                                    : smudged;
                            }
                        } catch (error) {
                            log_sanitized_failure('Git LFS resolve failed', error);
                            outcome = { type: 'failed', reason: 'failed' };
                        }
                        if (disposed || superseded()) return;
                        if (outcome.type === 'failed') {
                            unresolved_lfs = {
                                ...target,
                                failure: {
                                    reason: outcome.reason,
                                    ...(outcome.detail === undefined
                                        ? {}
                                        : { detail: outcome.detail }),
                                },
                            };
                            // Re-deliver so the banner can explain the failure.
                            // The source has not changed for this side, which is
                            // exactly why this state lives on the controller
                            // rather than on it.
                            //
                            // A refresh that adopts no source delivers no
                            // snapshot, and the failure just attached is real
                            // viewer material only a snapshot can carry.
                            // Without this the one case that most needs
                            // explaining — a cancelled file-size prompt, say —
                            // leaves a button and no message.
                            if (!await refresh_panel_source(true, 'recovery')) {
                                session.recapture_current_projection({ deliver: true });
                            }
                            return;
                        }
                        if (fetched) {
                            if (target.side === 'file') {
                                resolved_lfs_main = { oid: target.oid, content: fetched };
                            } else {
                                resolved_lfs_original = { oid: target.oid, content: fetched };
                            }
                        }
                    }
                    // Cleared before the rebuild rather than after: the build
                    // sets it again if a side is still a pointer, and leaving a
                    // stale failure in place would outlive the retry it
                    // describes.
                    unresolved_lfs = undefined;
                    if (
                        await refresh_panel_source(true, 'recovery')
                        // `false` also means "superseded", not just "failed",
                        // and conflating the two is what made the button look
                        // broken on real files. `git lfs pull` rewrites the
                        // file, which wakes the refresh watcher, whose reload
                        // supersedes this one — so the resolve reported failure
                        // and restored the banner *over the real table the
                        // other load had just delivered*. Re-reading the
                        // pointer state is the honest test: a build that ran
                        // since has already set it if a side is still a
                        // pointer, and left it clear if it is not.
                        || unresolved_lfs !== undefined
                    ) return;
                    for (const target of targets) {
                        if (!await file_is_still_a_pointer(target)) continue;
                        // Genuinely still unresolved, so the action has to stay
                        // retryable: with no banner there is no button.
                        unresolved_lfs = target;
                        if (target.side === 'original') resolved_lfs_original = undefined;
                        else resolved_lfs_main = undefined;
                        // Restoring the banner is pointless if no snapshot
                        // carries it back to the webview — the restored target
                        // is viewer material, like the failure above.
                        session.recapture_current_projection({ deliver: true });
                        return;
                    }
                    // Every object fetched, nothing left pointing — and yet
                    // the rebuild delivered nothing, because it failed
                    // outright (an oversized file, an unreadable side). No
                    // snapshot is owed here: nothing the panel shows has
                    // changed, and the `lfsResolveEnded` below is what tells
                    // the renderer the download is over. Manufacturing a
                    // delivery just to say so is exactly the coupling this
                    // response exists to remove.
                    } finally {
                        lfs_resolve_in_flight = false;
                    }
                } finally {
                    // Settle the request on every terminal path — success,
                    // failure, supersession, refusal at the door, or a throw —
                    // so the renderer's "Downloading…" state cannot outlive
                    // the operation it describes.
                    await post_to_receiver({
                        type: 'lfsResolveEnded',
                        requestId: msg.requestId,
                    }, resolve_receiver_epoch);
                }
                return;
            }
            case 'loadAllCsvRows':
                // Only a currently truncated CSV-like profile can make this do
                // useful work. The source check also makes duplicate clicks after
                // the replacement snapshot a no-op.
                if (!source?.truncationMessage || load_all_csv_rows) return;
                load_all_csv_rows = true;
                if (!await refresh_panel_source(true, 'recovery')) {
                    // A failed refresh must leave the action retryable.
                    load_all_csv_rows = false;
                }
                return;
            case 'saveCsv':
                if (editing_supported) {
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
            case 'pendingChangesChanged': {
                // Every refusal below is a silent drop from the renderer's point
                // of view: no acknowledgment is ever sent for the sequence, and a
                // native close waiting on that acknowledgment times out into the
                // "could not safely close" dialog. The drops are intentional —
                // stale or unauthorized publications must not be persisted — but
                // they must be observable, or that dialog is undiagnosable.
                const drop_publication = (
                    reason: string,
                    detail?: Record<string, unknown>,
                ) => {
                    console.warn('Dropped a pending structural publication', {
                        reason,
                        editSessionId: msg.editSessionId,
                        sequence: msg.sequence,
                        ...detail,
                    });
                };
                if (
                    !editing_supported
                    || !edit_message_is_current(msg.editSessionId)
                    || active_replay_commit !== undefined
                ) {
                    drop_publication('inactive', {
                        editingSupported: editing_supported,
                        sessionCurrent: edit_message_is_current(msg.editSessionId),
                        replayActive: active_replay_commit !== undefined,
                    });
                    return;
                }
                const publication_source = source;
                const publication_core = core;
                if (
                    publication_source === undefined
                    || publication_core === undefined
                    || !Number.isSafeInteger(msg.sourceGeneration)
                    || msg.sourceGeneration !== publication_core.source_generation
                ) {
                    drop_publication('source-generation-mismatch', {
                        messageGeneration: msg.sourceGeneration,
                        currentGeneration: publication_core?.source_generation,
                    });
                    return;
                }
                const changes = own_wire_pending_changes(msg.changes);
                if (!changes) {
                    drop_publication('malformed-changes');
                    return;
                }
                const message_target: WorksheetTarget = {
                    sheetIndex: changes.sheetIndex,
                    sheetName: changes.sheetName,
                    worksheetId: changes.worksheetId,
                };
                if (active_save_operation?.durableTargets.some((target) => (
                    worksheet_target_matches(target, message_target)
                    || worksheet_target_matches(message_target, target)
                ))) {
                    drop_publication('save-owns-target', {
                        saveTargets: active_save_operation.durableTargets,
                    });
                    return;
                }
                if (pending_edit_sequence_session_id !== msg.editSessionId) {
                    pending_edit_sequence_session_id = msg.editSessionId;
                    highest_pending_edit_sequence = 0;
                    highest_acknowledged_edit_sequence = 0;
                }
                if (!Number.isSafeInteger(msg.sequence) || msg.sequence <= 0) {
                    drop_publication('invalid-sequence');
                    return;
                }
                const sequence = msg.sequence;
                if (sequence <= highest_pending_edit_sequence) {
                    if (sequence <= highest_acknowledged_edit_sequence) {
                        await post_to_receiver({
                            type: 'pendingChangesAcknowledged',
                            editSessionId: msg.editSessionId,
                            sequence,
                        });
                    } else {
                        // The sequence was claimed by an earlier publication
                        // whose write later dropped; that publication logged its
                        // own reason, but this replay dying quietly is what a
                        // waiter actually observes.
                        drop_publication('sequence-claimed-but-unacknowledged', {
                            highestPending: highest_pending_edit_sequence,
                            highestAcknowledged: highest_acknowledged_edit_sequence,
                        });
                    }
                    return;
                }
                const sheets = source?.meta().sheets;
                const requires_identity = (sheets?.length ?? 0) > 1;
                if (
                    requires_identity
                    && changes.sheetName === undefined
                    && changes.worksheetId === undefined
                ) {
                    drop_publication('worksheet-identity-required');
                    return;
                }
                const live_posted_sheet = sheets?.[changes.sheetIndex];
                if (
                    !Number.isSafeInteger(changes.sheetIndex)
                    || changes.sheetIndex < 0
                    || (
                        changes.sheetName === undefined
                        && changes.worksheetId === undefined
                        && sheets !== undefined
                        && !live_posted_sheet
                    )
                ) {
                    drop_publication('worksheet-index-unresolved', {
                        sheetIndex: changes.sheetIndex,
                    });
                    return;
                }

                const posted_sheet_index = changes.sheetIndex;
                const posted_sheet_name = changes.sheetName;
                const posted_worksheet_id = changes.worksheetId;
                const requested_posted_target: WorksheetTarget = {
                    sheetIndex: posted_sheet_index,
                    sheetName: posted_sheet_name ?? live_posted_sheet?.name,
                    worksheetId: posted_worksheet_id ?? (
                        posted_sheet_name === undefined
                            ? live_posted_sheet?.worksheetId
                            : undefined
                        ),
                };
                const posted_target = canonical_worksheet_target(requested_posted_target);
                if (posted_target === undefined
                    || posted_target.sheetIndex !== requested_posted_target.sheetIndex) {
                    drop_publication('worksheet-target-uncanonical', {
                        requested: requested_posted_target,
                    });
                    return;
                }
                const publication_authority_revision = source_authority.authorityRevision;
                if (
                    source !== publication_source
                    || core !== publication_core
                    || publication_core.source_generation !== msg.sourceGeneration
                    || source_authority.authorityRevision !== publication_authority_revision
                    || !file_coordinator.state_write_is_current(
                        publication_authority_revision,
                    )
                ) {
                    drop_publication('stale-authority', {
                        authorityRevision: publication_authority_revision,
                    });
                    return;
                }
                const ledger_key = append_ledger_key(msg.editSessionId, posted_target);
                // Refuse malformed or partial admission batches before claiming
                // the renderer sequence. The same pure plan is rebuilt after
                // the write queues drain, where it becomes authoritative.
                if (plan_pending_structural_publication(
                    msg.editSessionId,
                    posted_target,
                    changes,
                    sequence,
                ) === undefined) {
                    drop_publication('admission-plan-refused', {
                        appendedRows: changes.appendedRows.length,
                        tailRemovals: changes.tailRemovals.length,
                        hasAppendBasis: changes.appendBasis !== undefined,
                    });
                    return;
                }
                const receiver_epoch = session.current_receiver_epoch;
                const edit_session_id = msg.editSessionId;
                const admission = Symbol(edit_session_id);
                pending_edit_admissions.add(admission);
                observe_pending_edit_target(edit_session_id, posted_target, sequence);
                highest_pending_edit_sequence = sequence;
                const prior_pending_write = pending_edit_writes.catch(() => {});
                const prior_append_admission = (append_admission_tails.get(
                    APPEND_ADMISSION_AUTHORITY_TAIL,
                ) ?? Promise.resolve()).catch(() => {});
                const publication_is_current = () => !disposed
                    && source === publication_source
                    && core === publication_core
                    && publication_core.source_generation === msg.sourceGeneration
                    && source_authority.authorityRevision === publication_authority_revision
                    && file_coordinator.state_write_is_current(
                        publication_authority_revision,
                    );
                const write = Promise.all([
                    prior_pending_write,
                    prior_append_admission,
                ]).then(async () => {
                    if (!publication_is_current()) {
                        drop_publication('stale-before-queued-write');
                        return;
                    }
                    const queued_snapshot = await read_file_state(false);
                    if (!publication_is_current()) {
                        drop_publication('stale-after-state-read');
                        return;
                    }
                    const queued_durable_state = normalize_host_state(
                        queued_snapshot.state,
                        publication_source.meta().sheets,
                    );
                    const queued_durable_structural = own_pending_structural_changes(
                        pending_changes_for_sheet(
                            queued_durable_state.pendingEdits,
                            posted_target.sheetIndex,
                            posted_target.sheetName,
                            posted_target.worksheetId,
                        ) ?? {},
                    );
                    const queued_projected_state = reconciled_against(
                        queued_snapshot,
                        publication_source,
                        false,
                    ).state as PerFileState;
                    const queued_structural = own_pending_structural_changes(
                        pending_changes_for_sheet(
                            queued_projected_state.pendingEdits,
                            posted_target.sheetIndex,
                            posted_target.sheetName,
                            posted_target.worksheetId,
                        ) ?? {},
                    );
                    const posted_structural = own_pending_structural_changes(changes);
                    const host_structural_echo = JSON.stringify(queued_structural)
                        === JSON.stringify(posted_structural);
                    if (
                        !host_structural_echo
                        && !await replay_structures_are_authorized([Object.freeze({
                            ordinal: 0,
                            worksheet: posted_target,
                            resolvedSheetIndex: posted_target.sheetIndex,
                            expected: EMPTY_PENDING_STRUCTURAL_CHANGES,
                            desired: posted_structural,
                        })], publication_source)
                    ) {
                        drop_publication('structural-replay-unauthorized', {
                            hostStructuralEcho: host_structural_echo,
                        });
                        return;
                    }
                    if (!publication_is_current()) {
                        drop_publication('stale-after-authorization');
                        return;
                    }
                    const authority_plan = plan_pending_structural_publication(
                        edit_session_id,
                        posted_target,
                        changes,
                        sequence,
                        true,
                    );
                    if (authority_plan === undefined) {
                        drop_publication('authority-plan-refused');
                        return;
                    }
                    let conflict_overlay_authorized = false;
                    const result = await update_edit_session_state(
                        edit_session_id,
                        admission,
                        (current, current_sheets) => {
                            conflict_overlay_authorized = false;
                            const has_identity = posted_worksheet_id !== undefined
                                || posted_sheet_name !== undefined;
                            const live_target_index = !has_identity
                                ? posted_sheet_index
                                : sheet_index_identified(
                                    posted_worksheet_id,
                                    posted_sheet_name,
                                    current_sheets,
                                );
                            let target_index = live_target_index;
                            if (has_identity && target_index === undefined) {
                                target_index = pending_edit_slot_index_identified(
                                    current.pendingEdits,
                                    posted_worksheet_id,
                                    posted_sheet_name,
                                    posted_sheet_index,
                                );
                                if (target_index === undefined) {
                                    const nonempty = Object.keys(changes.cells).length > 0
                                        || changes.appendedRows.length > 0
                                        || changes.tailRemovals.length > 0;
                                    if (!nonempty) return current;
                                    const hole = current.pendingEdits
                                        ?.findIndex((slot) => slot === undefined) ?? -1;
                                    target_index = hole >= 0
                                        ? hole
                                        : current.pendingEdits?.length ?? 0;
                                }
                            }
                            if (target_index === undefined) return current;
                            const current_structural = own_pending_structural_changes(
                                current.pendingEdits?.[target_index] ?? {},
                            );
                            if (host_structural_echo) {
                                if (JSON.stringify(current_structural)
                                    !== JSON.stringify(queued_durable_structural)) return current;
                            } else if (JSON.stringify(current_structural.conflicts)
                                !== JSON.stringify(changes.conflicts)) return current;
                            conflict_overlay_authorized = true;
                            const parked = has_identity && live_target_index === undefined;
                            const durable_changes = authority_plan.durableChanges;
                            const next = with_pending_changes_for_sheet(
                                current.pendingEdits,
                                target_index,
                                {
                                    cells: durable_changes.cells,
                                    formatTemplates: durable_changes.formatTemplates,
                                    appendedRows: durable_changes.appendedRows,
                                    tailRemovals: durable_changes.tailRemovals,
                                    ...(durable_changes.appendBasis === undefined
                                        ? {}
                                        : { appendBasis: durable_changes.appendBasis }),
                                    // Conflicts consume the host reserve. Echo the
                                    // authenticated durable overlay, never a
                                    // renderer-authored replacement.
                                    conflicts: host_structural_echo
                                        ? queued_structural.conflicts
                                        : current_structural.conflicts,
                                },
                                parked ? posted_sheet_name : current_sheets[target_index]?.name,
                                parked
                                    ? posted_worksheet_id
                                    : current_sheets[target_index]?.worksheetId,
                            );
                            if (next) return { ...current, pendingEdits: next };
                            if (!current.pendingEdits) return current;
                            const { pendingEdits: _drop, ...rest } = current;
                            return rest;
                        },
                        {
                            expectedAuthorityRevision: publication_authority_revision,
                            isCurrent: publication_is_current,
                        },
                    );
                    if (
                        result.type === 'aborted'
                        || !conflict_overlay_authorized
                        || !publication_is_current()
                        || !commit_pending_structural_publication(authority_plan)
                    ) {
                        drop_publication('durable-commit-refused', {
                            aborted: result.type === 'aborted',
                            overlayAuthorized: conflict_overlay_authorized,
                            current: publication_is_current(),
                        });
                        return;
                    }
                    retire_pending_edit_target(edit_session_id, posted_target, sequence);
                    const committed = result.snapshot.state as PerFileState;
                    const supersedes = (operation: CsvSaveOperation) => operation.worksheets
                        .some((worksheet) => {
                            const operation_index = operation_sheet_index(
                                worksheet,
                                undefined,
                                committed.pendingEdits,
                            );
                            if (operation_index === undefined) return false;
                            return !pending_changes_echo_operation(
                                pending_changes_for_sheet(
                                    committed.pendingEdits,
                                    operation_index,
                                    worksheet.sheetName,
                                    worksheet.worksheetId,
                                ),
                                worksheet,
                            );
                        });
                    const tombstone = file_edit_state?.failedSaveTombstone;
                    if (
                        file_edit_state
                        && tombstone
                        && (
                            tombstone.editSessionId !== edit_session_id
                            || supersedes(tombstone)
                        )
                    ) file_edit_state.failedSaveTombstone = undefined;
                    if (save_lifecycle.state === 'failed') {
                        const correlation = save_lifecycle_correlation(save_lifecycle);
                        if (
                            correlation?.editSessionId !== edit_session_id
                            || ('operation' in save_lifecycle && supersedes(save_lifecycle.operation))
                        ) retire_save_lifecycle(undefined, 'failed');
                    }
                    notify_edit_state(result.snapshot);
                    delete_shared_edit_state_if_unused();
                    highest_acknowledged_edit_sequence = Math.max(
                        highest_acknowledged_edit_sequence,
                        sequence,
                    );
                    await post_to_receiver({
                        type: 'pendingChangesAcknowledged',
                        editSessionId: msg.editSessionId,
                        sequence,
                    }, receiver_epoch);
                    resolve_pending_edit_ack_waiters();
                }).finally(() => pending_edit_admissions.delete(admission));
                pending_edit_writes = write;
                const append_tail = write.then(() => {}, () => {});
                append_admission_tails.set(APPEND_ADMISSION_AUTHORITY_TAIL, append_tail);
                await write;
                if (append_admission_tails.get(APPEND_ADMISSION_AUTHORITY_TAIL) === append_tail) {
                    append_admission_tails.delete(APPEND_ADMISSION_AUTHORITY_TAIL);
                }
                return;
            }
            case 'pendingEditsChanged': {
                if (!editing_supported || active_replay_commit !== undefined) return;
                if (!edit_message_is_current(msg.editSessionId)) return;
                const message_target: WorksheetTarget = {
                    sheetIndex: msg.sheetIndex ?? 0,
                    sheetName: msg.sheetName,
                    worksheetId: msg.worksheetId,
                };
                if (
                    active_save_operation
                    && (
                        active_save_operation.durableTargets.some((target) => (
                            worksheet_target_matches(target, message_target)
                            || worksheet_target_matches(message_target, target)
                        ))
                    )
                ) return;
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
                const receiver_epoch = session.current_receiver_epoch;
                const edit_session_id = msg.editSessionId;
                // Wire entries are untrusted and go durable below, where
                // `validate_edit_cells` rejects the whole `pendingEdits` leaf on
                // one malformed run side. Sanitizing here keeps a bad optional
                // field from poisoning every sheet's drafts at the next decode.
                // The wire variant also guards the record shape itself: a
                // renderer posting `null` or a non-record entry must not throw
                // past the handler — that entry is dropped, the rest survive.
                const edits = msg.edits
                    ? Object.fromEntries(
                        Object.entries(msg.edits).flatMap(([key, entry]) => {
                            const sanitized = sanitized_wire_dirty_entry(entry);
                            return sanitized ? [[key, sanitized] as const] : [];
                        }),
                    )
                    : null;
                const admission = Symbol(edit_session_id);
                pending_edit_admissions.add(admission);
                // The sheet the post names. Writes land in that slot only, so a
                // post about one worksheet cannot clear another's unsaved edits.
                // A post naming no sheet is accepted only for a single-sheet
                // source, preserving the legacy CSV renderer's sheet-0 default.
                // Workbook posts must carry both coordinates: otherwise an older
                // renderer editing a nonzero sheet would silently write its draft
                // into sheet 0. A complete identity need not still resolve in the
                // live workbook: an outgoing editor synchronously flushes after a
                // replacement snapshot installs, and that old identity must be
                // parked rather than rejected. Untagged single-sheet posts remain
                // bounded by their numeric index.
                //
                // Named as well as numbered, because the write below is queued behind
                // `pending_edit_writes` and can execute after a reload has reordered
                // the workbook. The index alone would then address a different
                // worksheet, and the write would store this sheet's edits in that
                // one's slot *tagged with its name* — which `reconcile_pending_edit_sheets`
                // reads as authoritative, so the mistake survives every later reload.
                // The authority fence does not catch this: the write captures its
                // expected revision when it executes, which is already after the reload.
                const sheets = source?.meta().sheets;
                const requires_sheet_identity = (sheets?.length ?? 0) > 1;
                const has_required_sheet_identity = !requires_sheet_identity
                    || (
                        msg.sheetIndex !== undefined
                        && (msg.worksheetId !== undefined || msg.sheetName !== undefined)
                    );
                const posted_sheet_index = msg.sheetIndex ?? 0;
                const posted_sheet_name = msg.sheetName;
                const posted_worksheet_id = msg.worksheetId;
                const has_posted_sheet_identity = posted_worksheet_id !== undefined
                    || posted_sheet_name !== undefined;
                const posted_sheet_valid = has_required_sheet_identity
                    && Number.isSafeInteger(posted_sheet_index)
                    && posted_sheet_index >= 0
                    && (
                        has_posted_sheet_identity
                        || sheets === undefined
                        || posted_sheet_index < sheets.length
                    );
                if (!posted_sheet_valid) {
                    pending_edit_admissions.delete(admission);
                    return;
                }
                const live_posted_sheet = sheets?.[posted_sheet_index];
                const posted_target: WorksheetTarget = {
                    sheetIndex: posted_sheet_index,
                    sheetName: posted_sheet_name ?? live_posted_sheet?.name,
                    worksheetId: posted_worksheet_id ?? (
                        posted_sheet_name === undefined
                            ? live_posted_sheet?.worksheetId
                            : undefined
                    ),
                };
                observe_pending_edit_target(edit_session_id, posted_target, sequence);
                highest_pending_edit_sequence = sequence;
                const write = pending_edit_writes.catch(() => {}).then(async () => {
                    const apply = (
                        current: PerFileState,
                        sheets: readonly SheetMeta[],
                        cells: SheetPendingEditCells | undefined,
                    ): PerFileState => {
                        // Resolve against the workbook at execution time so reorder
                        // follows the worksheet. An identity that no longer resolves
                        // is an outgoing editor's replacement-time flush: keep it in
                        // an identity-tagged parked slot, never at the captured index
                        // now occupied by the replacement worksheet.
                        const has_identity = posted_worksheet_id !== undefined
                            || posted_sheet_name !== undefined;
                        const live_target_index = !has_identity
                            ? posted_sheet_index
                            : sheet_index_identified(
                                posted_worksheet_id,
                                posted_sheet_name,
                                sheets,
                            );
                        let target_index = live_target_index;
                        if (has_identity && target_index === undefined) {
                            target_index = pending_edit_slot_index_identified(
                                current.pendingEdits,
                                posted_worksheet_id,
                                posted_sheet_name,
                                posted_sheet_index,
                            );
                            if (target_index === undefined) {
                                if (!cells || Object.keys(cells).length === 0) return current;
                                const hole = current.pendingEdits
                                    ?.findIndex((slot) => slot === undefined) ?? -1;
                                target_index = hole >= 0
                                    ? hole
                                    : current.pendingEdits?.length ?? 0;
                            }
                        }
                        if (target_index === undefined) return current;
                        const parked = has_identity && live_target_index === undefined;
                        const next = with_pending_edits_for_sheet(
                            current.pendingEdits,
                            target_index,
                            cells,
                            parked ? posted_sheet_name : sheets[target_index]?.name,
                            parked ? posted_worksheet_id : sheets[target_index]?.worksheetId,
                        );
                        if (next) return { ...current, pendingEdits: next };
                        if (!current.pendingEdits) return current;
                        const { pendingEdits: _drop, ...rest } = current;
                        return rest;
                    };
                    const result = await update_edit_session_state(
                        edit_session_id,
                        admission,
                        (current, sheets) => apply(current, sheets, edits ?? undefined),
                    );
                    if (result.type !== 'aborted') {
                        retire_pending_edit_target(
                            edit_session_id,
                            posted_target,
                            sequence,
                        );
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
                        const supersedes = (operation: CsvSaveOperation) => operation.worksheets
                            .some((worksheet) => {
                                const operation_index = operation_sheet_index(
                                    worksheet,
                                    undefined,
                                    committed.pendingEdits,
                                );
                                if (operation_index === undefined) return false;
                                return !post_echoes_operation(
                                    pending_edits_for_sheet(
                                        committed.pendingEdits,
                                        operation_index,
                                        worksheet.sheetName,
                                        worksheet.worksheetId,
                                    ),
                                    worksheet,
                                );
                            });
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
                        if (save_lifecycle.state === 'failed') {
                            const correlation = save_lifecycle_correlation(save_lifecycle);
                            const should_retire = correlation?.editSessionId !== edit_session_id
                                || (
                                    'operation' in save_lifecycle
                                    && supersedes(save_lifecycle.operation)
                                );
                            if (should_retire) {
                                retire_save_lifecycle(undefined, 'failed');
                            }
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
            case 'prepareHistoryReplay': {
                const request = sanitized_prepare_history_replay_request(msg.request);
                const receiver_epoch = session.current_receiver_epoch;
                if (request === undefined) {
                    // A malformed request may still carry a usable correlation,
                    // and answering it is what keeps the renderer from hanging on
                    // a replay that will never be prepared. Without one there is
                    // nothing to answer to, and inventing an id would refuse a
                    // replay nobody is waiting on while leaving the real one hung.
                    const raw = msg.request;
                    if (
                        !is_plain_record(raw)
                        || typeof raw.requestId !== 'string'
                        || typeof raw.replayId !== 'string'
                    ) return;
                    void post_to_receiver({
                        type: 'historyReplayPrepareRefused',
                        refusal: {
                            requestId: raw.requestId,
                            replayId: raw.replayId,
                            reason: 'malformed',
                        },
                    }, receiver_epoch);
                    return;
                }
                const refuse = (
                    reason: HistoryReplayPrepareRefused['reason'],
                ): void => {
                    void post_to_receiver({
                        type: 'historyReplayPrepareRefused',
                        refusal: {
                            requestId: request.requestId,
                            replayId: request.replayId,
                            reason,
                        },
                    }, receiver_epoch);
                };
                // One preparation at a time, and none while a lease is already
                // live: two replays interleaving would each plan against a
                // document the other is moving. The renderer serializes too, so
                // reaching this is a stale request rather than a race worth
                // queueing.
                if (
                    save_blocks_history_replay()
                    || history_replay_blocks_save()
                ) {
                    refuse('busy');
                    return;
                }
                // A replay carrying cell writes mutates session-owned pending-edit
                // state; one carrying only highlights mutates durable workbook
                // state, which the ordinary highlight commands change with no
                // session and outside edit mode. So the session requirement follows
                // the cells — read through the shared derivation, so this gate and
                // the lease binding below cannot disagree about what it admitted.
                const requires_edit_session = replay_request_requires_edit_session(request);
                if (profile.previewMode === true) {
                    refuse('unavailable');
                    return;
                }
                if (requires_edit_session && !editing_supported) {
                    refuse('unavailable');
                    return;
                }
                if (
                    requires_edit_session
                    && (!owns_edit_session() || edit_cleanup_blocked())
                ) {
                    refuse('edit-session-unavailable');
                    return;
                }
                replay_preparation_in_flight = true;
                try {
                    await prepare_history_replay(request, receiver_epoch, refuse);
                } finally {
                    replay_preparation_in_flight = false;
                }
                return;
            }
            case 'commitHistoryReplay': {
                const request = sanitized_commit_history_replay_request(msg.request);
                const receiver_epoch = session.current_receiver_epoch;
                if (request === undefined) {
                    const raw = msg.request;
                    if (
                        !is_plain_record(raw)
                        || typeof raw.requestId !== 'string'
                        || typeof raw.replayId !== 'string'
                        || typeof raw.leaseId !== 'string'
                        || typeof raw.mutationId !== 'string'
                    ) return;
                    void post_to_receiver({
                        type: 'historyReplayCommitRefused',
                        refusal: {
                            requestId: raw.requestId,
                            replayId: raw.replayId,
                            leaseId: raw.leaseId,
                            mutationId: raw.mutationId,
                            reason: 'malformed',
                        },
                    }, receiver_epoch);
                    return;
                }
                // Synchronous and before any await: the decision is what makes
                // taking the lease exactly-once, so nothing may interleave
                // between reading it and transitioning it.
                const decision = replay_leases.decide_commit(request, Date.now());
                if (decision.kind === 'refuse') {
                    void post_to_receiver({
                        type: 'historyReplayCommitRefused',
                        refusal: {
                            requestId: request.requestId,
                            replayId: request.replayId,
                            leaseId: request.leaseId,
                            mutationId: request.mutationId,
                            reason: decision.reason,
                        },
                    }, receiver_epoch);
                    return;
                }
                if (decision.kind === 'replay') {
                    // A lost acknowledgement. The document was already mutated
                    // once; re-post the answer and touch nothing.
                    await post_history_replay_outcome(
                        decision.settled.result,
                        receiver_epoch,
                    );
                    return;
                }
                if (decision.kind === 'join') {
                    // The commit is already running. Await the SAME operation
                    // rather than returning silently: the mutation must not run
                    // twice, but the renderer that retried is waiting for an
                    // answer, and a `join` that answered nothing would leave it
                    // waiting forever if the original post was the one that got
                    // lost. Awaiting the shared promise gives both callers the one
                    // outcome the single mutation produced.
                    const running = active_replay_commit;
                    if (running === undefined) return;
                    await post_history_replay_outcome(await running, receiver_epoch);
                    return;
                }
                const operation = run_history_replay_commit(request, decision.lease.payload);
                await post_history_replay_outcome(await operation, receiver_epoch);
                return;
            }
            case 'abandonHistoryReplay': {
                const request = sanitized_abandon_history_replay_request(msg.request);
                if (request === undefined) return;
                // Silent by design, and silent about a lease already committing:
                // abandonment races a commit the renderer has already sent, and
                // losing that race must not cancel the mutation.
                replay_leases.abandon(request.leaseId);
                return;
            }
            case 'pendingChangesFlush':
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
            case 'pendingChangesFlushFailed':
            case 'pendingEditsFlushFailed': {
                const waiter = pending_edit_flush_waiters.get(msg.requestId);
                if (!waiter) return;
                pending_edit_flush_waiters.delete(msg.requestId);
                waiter.reject(new Error(
                    'Viewer renderer could not complete the pending-edit flush.',
                ));
                return;
            }
            case 'showSaveDialog': {
                if (!editing_supported || !edit_message_is_current(msg.editSessionId)) return;
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
                await post_to_receiver({
                    type: 'saveDialogResult',
                    requestId: request.requestId,
                    editSessionId: request.editSessionId,
                    choice,
                }, request.receiverEpoch);
                flush_sheet_selections();
                return;
            }
            case 'requestSourceDisplayRows': {
                const request_core = core;
                const sheet = source?.meta().sheets[msg.sheetIndex];
                if (
                    request_core === undefined
                    || sheet === undefined
                    || msg.generation !== request_core.generation
                    || typeof msg.requestId !== 'string'
                    || msg.requestId.length === 0
                    || msg.requestId.length > 256
                    || !Array.isArray(msg.sourceRows)
                    || msg.sourceRows.length > MAX_PENDING_APPENDED_ROWS + 1
                    || new Set(msg.sourceRows).size !== msg.sourceRows.length
                    || msg.sourceRows.some((row) => !Number.isSafeInteger(row)
                        || row < 0 || row >= MAX_SHEET_ROWS)
                ) return;
                await post_to_receiver({
                    type: 'sourceDisplayRows',
                    requestId: msg.requestId,
                    sheetIndex: msg.sheetIndex,
                    sourceRows: Object.freeze([...msg.sourceRows]),
                    displayRows: Object.freeze(msg.sourceRows.map((row) =>
                        request_core.display_row_for_source(msg.sheetIndex, row) ?? null)),
                    generation: msg.generation,
                    mappingGeneration: request_core.mapping_generation(msg.sheetIndex),
                });
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
    };
    try {
        disposables.push(webview.onDidReceiveMessage(receive_webview_message));
        options.integrationTestPort?.register_webview_message_receiver(
            receive_webview_message,
        );
    } catch (error) {
        return abort_setup(error);
    }

    function stop_edit_admission(): void {
        if (edit_admission_closed) return;
        edit_admission_closed = true;
        active_edit_session_request = undefined;
        cancel_edit_claim(active_edit_claim);
    }

    /**
     * Verify a replay against the acknowledged document, then issue its lease.
     *
     * Three independent classes of check, in the order that makes each one cheap
     * to reach. None subsumes another; see the protocol module's header.
     *
     *   1. AGREEMENT — the host and renderer must be describing one document, so
     *      the coordinates in the request mean what the renderer meant by them.
     *   2. COMPARE-AND-SWAP — every requested overlay must equal durable pending
     *      -edit state and every highlight its expected colour. This is what
     *      makes a replay refuse rather than overwrite an edit it never saw.
     *   3. PHYSICAL CURRENCY — the acknowledged source must still be an accurate
     *      parse of the bytes on disk, since the watcher may not yet have seen an
     *      external write. Done last because it costs a read of the whole file.
     *
     * Deliberately does NOT build or adopt a source. An adoption bumps the source
     * generation and the document epoch, so a replay that forced one would
     * invalidate its own lease; and it would buy nothing, because the host reads
     * any row of the current source directly. The save path is the precedent.
     *
     * Deliberately does NOT run `establish_pending_edit_flush_boundary` either.
     * That protocol stops edit admission and republishes every store — it is a
     * close/reload mechanism, and running it per undo keypress would both cost a
     * round trip and reject the whole pending-edit protocol on its timeout.
     * Draining `pending_edit_writes` is what soundness actually needs: it
     * establishes that every edit the host has ADMITTED is durable, and an
     * unpublished local overlay that disagrees with durable state is caught by
     * the compare-and-swap as a conflict rather than guessed at.
     */
    async function prepare_history_replay(
        request: PrepareHistoryReplayRequest,
        receiver_epoch: number,
        refuse: (reason: HistoryReplayPrepareRefused['reason']) => void,
    ): Promise<void> {
        // Every edit the host has already admitted becomes durable before
        // anything is compared against durable state. A message still in the
        // renderer's own queue is not covered, and does not need to be: it will
        // disagree with what is read here and refuse as a conflict.
        await pending_edit_writes.catch(() => {});

        const adoption = session.current_adoption();
        const src = source;
        const replay_core = core;
        const observation = source_observation;
        const expected_digest = session.acknowledged_physical_digest();
        const expected_authority = source_authority.authorityRevision;
        const expected_physical_revision = source_authority.physicalRevision;
        // Bound only for a replay that writes pending edits. A highlight-only
        // lease must be independent of the edit session in BOTH directions: it
        // cannot require one, and it must not be invalidated by one starting or
        // ending underneath it — highlights are not session state. The same
        // derivation the admission gate used, so the lease cannot bind under
        // assumptions the gate did not apply.
        const requires_edit_session = replay_request_requires_edit_session(request);
        const edit_session = requires_edit_session ? active_edit_session_id : undefined;
        const bound_source_generation = replay_core?.source_generation;
        const row_admission_request_ids = request.rowAdmissionRequestIds ?? [];
        let row_admission_lease_id: string | undefined;

        /**
         * Whether everything the lease is bound to is still in place.
         *
         * Rechecked after every await here and again at commit. Binds
         * `source_generation` and not `core.generation`: a transform advances the
         * view without moving the source rows a replay addresses, so pinning the
         * view generation would refuse replays that are perfectly sound.
         */
        const replay_is_current = (): boolean => !disposed
            && session.current_receiver_epoch === receiver_epoch
            && src !== undefined
            && replay_core !== undefined
            && core === replay_core
            && source === src
            && session.current_adoption() === adoption
            && adoption?.resources.source === src
            && adoption.resources.core === replay_core
            && replay_core.source_generation === bound_source_generation
            && source_observation === observation
            && session.acknowledged_current()
            && source_authority.authorityRevision === expected_authority
            && source_authority.physicalRevision === expected_physical_revision
            && file_coordinator.state_write_is_current(expected_authority)
            && (
                row_admission_lease_id === undefined
                || replay_row_admissions_for_structures(
                    row_admission_request_ids,
                    resolved_structures,
                    bound_source_generation!,
                    row_admission_lease_id,
                ) !== undefined
            )
            // Every term above is unconditional — the document, source, adoption,
            // authority and digest identities bind every lease. Only the session
            // terms are conditional, and a highlight-only lease is still
            // self-invalidating without them.
            && (
                !requires_edit_session
                || (
                    owns_edit_session()
                    && !edit_cleanup_blocked()
                    && active_edit_session_id === edit_session
                )
            );

        if (
            src === undefined
            || replay_core === undefined
            || observation === undefined
            || expected_digest === undefined
            || !!src.truncationMessage
            || !replay_is_current()
        ) {
            refuse('document-changed');
            return;
        }

        // 1. AGREEMENT. Resolve every worksheet the request names against the
        // acknowledged workbook, by the same identity hierarchy durable state is
        // reconciled by, so a renamed or reordered sheet resolves or refuses
        // rather than silently addressing its new occupant.
        const sheets = src.meta().sheets;
        const lookup = worksheet_target_lookup(sheets);
        const resolved_cells: { readonly input: typeof request.cells[number]; readonly sheetIndex: number }[] = [];
        const resolved_cell_coordinates = new Set<string>();
        for (const cell of request.cells) {
            const sheet_index = lookup(cell.worksheet);
            const sheet = sheet_index === undefined ? undefined : sheets[sheet_index];
            if (
                sheet_index === undefined
                || sheet === undefined
                || cell.sourceRow >= sheet.sourceRowCount
                || cell.sourceColumn >= sheet.columnCount
            ) {
                refuse('unavailable');
                return;
            }
            const coordinate = `${sheet_index}:${cell.sourceRow}:${cell.sourceColumn}`;
            // One addressed cell has one ordinal even when a gesture touched it
            // repeatedly. Besides making the prepare/commit correspondence
            // ambiguous, accepting duplicates would let a tiny overlay request
            // amplify one source-owned 32 KiB cell thousands of times in the
            // prepared response.
            if (resolved_cell_coordinates.has(coordinate)) {
                refuse('malformed');
                return;
            }
            resolved_cell_coordinates.add(coordinate);
            resolved_cells.push({ input: cell, sheetIndex: sheet_index });
        }
        const highlight_sheet_indices = new Map<number, number>();
        for (const highlight of request.highlights) {
            const sheet_index = lookup(highlight.worksheet);
            const sheet = sheet_index === undefined ? undefined : sheets[sheet_index];
            if (
                sheet_index === undefined
                || sheet === undefined
                || highlight.sourceRow >= sheet.sourceRowCount
                || highlight.sourceColumn >= sheet.columnCount
            ) {
                refuse('unavailable');
                return;
            }
            highlight_sheet_indices.set(highlight.ordinal, sheet_index);
        }
        const resolved_structures: (HistoryReplayStructuralInput & {
            readonly resolvedSheetIndex: number;
        })[] = [];
        const structural_sheet_indices = new Set<number>();
        for (const structural of request.structures ?? []) {
            const sheet_index = lookup(structural.worksheet);
            const sheet = sheet_index === undefined ? undefined : sheets[sheet_index];
            if (
                sheet_index === undefined
                || sheet === undefined
                || structural_sheet_indices.has(sheet_index)
            ) {
                refuse('unavailable');
                return;
            }
            structural_sheet_indices.add(sheet_index);
            resolved_structures.push(Object.freeze({
                ...structural,
                resolvedSheetIndex: sheet_index,
            }));
        }
        const authorized_row_admissions = replay_row_admissions_for_structures(
            row_admission_request_ids,
            resolved_structures,
            replay_core.source_generation,
        );
        if (
            authorized_row_admissions === undefined
            || !await replay_structures_are_authorized(
                resolved_structures,
                src,
                authorized_row_admissions,
            )
        ) {
            refuse('conflict');
            return;
        }
        if (!replay_is_current()) {
            refuse('document-changed');
            return;
        }
        const focus_sheet_index = lookup(request.focus.worksheet);
        if (focus_sheet_index === undefined) {
            refuse('unavailable');
            return;
        }

        // Materialize the content each cell's overlay sits on top of, batched by
        // row rather than one read per cell: a workbook-wide gesture can name
        // thousands, and an undo keypress must not walk the source once each.
        const materialized = materialize_replay_cells(
            src,
            resolved_cells.map(({ input, sheetIndex }) => ({
                sheet_index: sheetIndex,
                source_row: input.sourceRow,
                source_column: input.sourceColumn,
            })),
        );
        if (!replay_is_current()) {
            refuse('document-changed');
            return;
        }
        const prepared_cells: HistoryReplayPreparedCell[] = [];
        for (const { input, sheetIndex } of resolved_cells) {
            const content = materialized.get(
                `${sheetIndex}:${input.sourceRow}:${input.sourceColumn}`,
            );
            // A cell the source cannot answer for is refused, never defaulted to
            // empty: an undo would otherwise write emptiness over content it
            // never saw.
            if (content === undefined) {
                refuse('unavailable');
                return;
            }
            prepared_cells.push(Object.freeze({
                ordinal: input.ordinal,
                worksheet: input.worksheet,
                resolvedSheetIndex: sheetIndex,
                sourceRow: input.sourceRow,
                sourceColumn: input.sourceColumn,
                overlay: input.overlay,
                persisted: content.rich === undefined
                    ? { text: content.text }
                    : { text: content.text, runs: content.rich },
                persistedHyperlink: content.hyperlink,
            }));
        }

        // 2. COMPARE-AND-SWAP against durable state.
        const state = await read_file_state(false);
        if (!replay_is_current()) {
            refuse('document-changed');
            return;
        }
        const current = normalize_host_state(state.state, sheets);
        if (!replay_overlays_match_durable(current, prepared_cells, sheets)) {
            refuse('conflict');
            return;
        }
        if (!replay_highlights_match_durable(
            current,
            request.highlights,
            highlight_sheet_indices,
            sheets,
        )) {
            refuse('conflict');
            return;
        }
        if (!replay_structures_match_durable(current, resolved_structures, sheets)) {
            refuse('conflict');
            return;
        }
        if (
            request.cells.length === 0
            && replay_structures_have_ambiguous_pending_formulas(
                current,
                resolved_structures,
                sheets,
                [],
                false,
            )
            && !resolved_structures.some((structural) =>
                structural.desired.conflicts.some(
                    (conflict) => conflict.reason === 'ambiguousPendingFormula',
                ))
        ) {
            refuse('conflict');
            return;
        }
        // 3. PHYSICAL CURRENCY. Last because it reads the whole file, and a
        // conflict found above would have made the read wasted work.
        const physical = await replay_physical_source_is_current(
            src,
            observation,
            expected_digest,
            expected_authority,
            () => !replay_is_current(),
        );
        if (!replay_is_current()) {
            refuse('document-changed');
            return;
        }
        if (!physical) {
            refuse('document-changed');
            return;
        }

        const now = Date.now();
        const lease_id = `${request.requestId}:${now}`;
        const owned_prepared_cells = Object.freeze(prepared_cells);
        const owned_resolved_structures = Object.freeze(resolved_structures);
        const prepared_message: HostMessage = Object.freeze({
            type: 'historyReplayPrepared',
            prepared: Object.freeze({
                requestId: request.requestId,
                replayId: request.replayId,
                leaseId: lease_id,
                focusSheetIndex: focus_sheet_index,
                focus: request.focus,
                cells: owned_prepared_cells,
                structures: owned_resolved_structures,
            }),
        });
        try {
            // Preparation adds persisted source content that was not in the
            // bounded renderer request. Bound the exact outbound message before
            // either retaining a lease payload or asking structured clone to
            // transport it.
            assert_json_encoded_bound(
                prepared_message,
                MAX_HISTORY_ACTION_ENCODED_BYTES,
            );
        } catch {
            refuse('unavailable');
            return;
        }
        const lease = replay_leases.issue(
            {
                leaseId: lease_id,
                requestId: request.requestId,
                replayId: request.replayId,
            },
            {
                cells: owned_prepared_cells,
                structures: owned_resolved_structures,
                rowAdmissionRequestIds: Object.freeze([...row_admission_request_ids]),
                highlights: request.highlights,
                highlightSheetIndices: highlight_sheet_indices,
                focus: request.focus,
                focusSheetIndex: focus_sheet_index,
                sourceGeneration: replay_core.source_generation,
                isCurrent: replay_is_current,
            },
            now,
        );
        if (lease === undefined) {
            refuse('busy');
            return;
        }
        if (!lease_replay_row_admissions(row_admission_request_ids, lease.leaseId)) {
            replay_leases.abandon(lease.leaseId);
            refuse('conflict');
            return;
        }
        row_admission_lease_id = lease.leaseId;
        // Awaited, unlike most posts here: the lease is already live, and a
        // renderer that never learned its id can neither spend nor abandon it —
        // it would hold the one-at-a-time slot and refuse every replay as `busy`
        // until its TTL ran out. Abandoning on a failed delivery is what keeps the
        // slot's occupancy tied to a renderer that actually knows about it.
        const delivered = await post_to_receiver(prepared_message, receiver_epoch);
        // Conditional on this exact lease, so a newer one issued in the meantime
        // is never the thing dropped.
        if (!delivered) {
            // The renderer never learned this lease or took responsibility for
            // settling its restoration grants. Cancel them even if checking the
            // registry observes that the lease expired during a slow post.
            // Both operations are exact-ID/idempotent, so neither can touch a
            // newer lease or an already-started commit.
            cancel_replay_row_admissions(row_admission_request_ids, lease.leaseId);
            replay_leases.abandon(lease.leaseId);
        }
    }

    /** The answer for a settled replay, whichever way it went. */
    function history_replay_result_message(
        result: HistoryReplayCommitted | HistoryReplayCommitRefused,
    ): HostMessage {
        return 'reason' in result
            ? { type: 'historyReplayCommitRefused', refusal: result }
            : { type: 'historyReplayCommitted', committed: result };
    }

    /**
     * The terminal must cross the renderer boundary before a refresh exposes the
     * replay's durable pending-state arm. Otherwise snapshot reconciliation moves
     * the renderer stores first and their old→new CAS in the terminal cannot stage,
     * leaving the host mutation committed while history remains unmoved.
     */
    async function post_history_replay_outcome(
        outcome: HistoryReplayCommitOutcome,
        receiver_epoch: number,
    ): Promise<void> {
        const delivered = await post_to_receiver(
            history_replay_result_message(outcome.result),
            receiver_epoch,
        );
        if (
            delivered
            && outcome.publishCurrentMaterial
            && !('reason' in outcome.result)
            && !disposed
        ) {
            session.deliver_current_material();
        }
    }

    /**
     * Run a taken commit to a terminal answer, exactly once, and settle its lease.
     *
     * Total by construction. A committing lease deliberately has no TTL — its
     * answer must stay recoverable by a lost acknowledgement — so an operation
     * that threw without settling would leave the lease committing forever:
     * every retry would `join` an operation that had already died, and every new
     * preparation would be refused as `busy` until the panel reloaded. So the
     * whole operation is wrapped, and a thrown failure becomes a refusal that is
     * recorded like any other.
     *
     * `unavailable` rather than `conflict` for a thrown failure, because the two
     * say different things to the renderer: a conflict means the document moved
     * and the user may retry, while a failure of unknown outcome means this replay
     * cannot be trusted to have left the document where the history thinks it is.
     */
    function run_history_replay_commit(
        request: CommitHistoryReplayRequest,
        payload: ReplayLeasePayload,
    ): Promise<HistoryReplayCommitOutcome> {
        const prior_append_authority = append_admission_tails.get(
            APPEND_ADMISSION_AUTHORITY_TAIL,
        ) ?? Promise.resolve();
        let append_tail: Promise<void>;
        const operation = prior_append_authority.catch(() => {}).then(() =>
            commit_history_replay(request, payload))
            .catch((error: unknown): HistoryReplayCommitRefused => {
                console.warn('History replay commit failed', error);
                return Object.freeze({
                    requestId: request.requestId,
                    replayId: request.replayId,
                    leaseId: request.leaseId,
                    mutationId: request.mutationId,
                    reason: 'unavailable' as const,
                });
            })
            .then((result) => {
                if ('reason' in result) {
                    release_replay_row_admissions(
                        payload.rowAdmissionRequestIds,
                        request.leaseId,
                    );
                }
                const outcome = Object.freeze({
                    result,
                    publishCurrentMaterial: !('reason' in result)
                        && payload.highlights.length > 0,
                });
                replay_leases.settle(request.leaseId, outcome, Date.now());
                return outcome;
            })
            .finally(() => {
                if (active_replay_commit === operation) active_replay_commit = undefined;
                if (append_admission_tails.get(APPEND_ADMISSION_AUTHORITY_TAIL) === append_tail) {
                    append_admission_tails.delete(APPEND_ADMISSION_AUTHORITY_TAIL);
                }
            });
        active_replay_commit = operation;
        append_tail = operation.then(() => {}, () => {});
        append_admission_tails.set(APPEND_ADMISSION_AUTHORITY_TAIL, append_tail);
        return operation;
    }

    /**
     * Apply a leased replay: re-verify, then move pending edits and highlights in
     * ONE compare-and-swap.
     *
     * One update, not two, because a replay is one undo. Two writes would let a
     * reader observe the cells moved and the highlights not, and — worse — would
     * leave the document in that split state permanently if the second failed,
     * with no history entry able to describe it.
     *
     * Everything mutated is named by ordinal against the retained preparation.
     * The request contributes no coordinates, no worksheets and no colours: the
     * cell writes carry entries the renderer computed, and even those are only
     * applied at addresses preparation resolved and verified.
     */
    async function commit_history_replay(
        request: CommitHistoryReplayRequest,
        payload: ReplayLeasePayload,
    ): Promise<HistoryReplayCommitted | HistoryReplayCommitRefused> {
        const refused = (
            reason: HistoryReplayCommitRefused['reason'],
        ): HistoryReplayCommitRefused => Object.freeze({
            requestId: request.requestId,
            replayId: request.replayId,
            leaseId: request.leaseId,
            mutationId: request.mutationId,
            reason,
        });

        // Every write must name a cell preparation verified, and every prepared
        // cell must be written: a partial proposal is a different gesture from
        // the one the lease authorizes, and applying it would leave half an undo.
        const by_ordinal = new Map(payload.cells.map((cell) => [cell.ordinal, cell]));
        if (request.cells.length !== payload.cells.length) return refused('proposal-mismatch');
        const writes: (ReplayCellWrite & { readonly ordinal: number; readonly key: string })[] = [];
        for (const write of request.cells) {
            const prepared = by_ordinal.get(write.ordinal);
            if (prepared === undefined) return refused('proposal-mismatch');
            writes.push({
                ordinal: write.ordinal,
                sheetIndex: prepared.resolvedSheetIndex,
                sourceRow: prepared.sourceRow,
                sourceColumn: prepared.sourceColumn,
                key: replay_cell_key(prepared.sourceRow, prepared.sourceColumn),
                entry: write.entry,
            });
        }
        const highlight_ordinals = new Set(request.highlights.map((write) => write.ordinal));
        if (highlight_ordinals.size !== payload.highlights.length) {
            return refused('proposal-mismatch');
        }
        const highlights = payload.highlights.filter(
            (highlight) => highlight_ordinals.has(highlight.ordinal),
        );
        if (highlights.length !== payload.highlights.length) {
            return refused('proposal-mismatch');
        }
        const structural_ordinals = new Set(
            (request.structures ?? []).map((write) => write.ordinal),
        );
        if (
            structural_ordinals.size !== payload.structures.length
            || payload.structures.some((structural) => !structural_ordinals.has(structural.ordinal))
        ) return refused('proposal-mismatch');
        const authorization_source = source;
        const authorized_row_admissions = replay_row_admissions_for_structures(
            payload.rowAdmissionRequestIds,
            payload.structures,
            payload.sourceGeneration,
            request.leaseId,
        );
        if (
            authorization_source === undefined
            || authorized_row_admissions === undefined
            || !await replay_structures_are_authorized(
                payload.structures,
                authorization_source,
                authorized_row_admissions,
            )
        ) {
            return refused('conflict');
        }
        if (!payload.isCurrent()) return refused('document-changed');

        await pending_edit_writes.catch(() => {});
        if (!payload.isCurrent()) return refused('document-changed');
        const src = source;
        const replay_core = core;
        const observation = source_observation;
        const expected_digest = session.acknowledged_physical_digest();
        const expected_authority = source_authority.authorityRevision;
        const physical_digest = source_authority.physicalDigest;
        if (
            src === undefined
            || replay_core === undefined
            || observation === undefined
            || expected_digest === undefined
            || physical_digest === undefined
        ) return refused('document-changed');

        // The file again, because preparation's check is old by now: a replay
        // waits on a user keypress and a round trip.
        //
        // What this re-verification does NOT close, and cannot — the same
        // filesystem TOCTOU the save path documents at its pre-write stat:
        //  - A write landing between this check and the compare-and-swap below
        //    is not detected here. The gap is the filesystem's own plus the
        //    event-loop turns that resume these continuations. Only an advisory
        //    lock or an OS-level compare-and-swap would close it, and
        //    `FileSystemPort` exposes no handle to build either on.
        //  - A same-size write within the same coarse mtime tick is invisible to
        //    any {size, mtime} comparison; it is caught only by the digest, and
        //    only if it lands before the read.
        //
        // What bounds the consequence is that this is not a write path. The
        // replay mutates only durable pending-edit and highlight state, and it
        // does so under a compare-and-swap whose expectations were recorded at
        // preparation. A file that changed inside the residual window costs the
        // replay a refusal — the user retries after the reload lands — never a
        // mutation against bytes nobody read, and never a partial application.
        if (!await replay_physical_source_is_current(
            src,
            observation,
            expected_digest,
            expected_authority,
            () => !payload.isCurrent(),
        )) return refused('document-changed');
        if (!payload.isCurrent()) return refused('document-changed');

        const sheets = src.meta().sheets;
        // The content the lease was issued against, re-read. The digest proves
        // the FILE has not moved; this proves the host's READING of it has not,
        // which is a different thing once a projection or header promotion can
        // change how a source row is reached.
        const materialized = materialize_replay_cells(
            src,
            payload.cells.map((cell) => ({
                sheet_index: cell.resolvedSheetIndex,
                source_row: cell.sourceRow,
                source_column: cell.sourceColumn,
            })),
        );
        const current_content = payload.cells.map((cell) => {
            const content = materialized.get(
                `${cell.resolvedSheetIndex}:${cell.sourceRow}:${cell.sourceColumn}`,
            );
            return content === undefined
                ? undefined
                : {
                    persisted: content.rich === undefined
                        ? { text: content.text }
                        : { text: content.text, runs: content.rich },
                    persistedHyperlink: content.hyperlink,
                };
        });
        if (current_content.some((entry) => entry === undefined)) {
            return refused('document-changed');
        }
        if (!prepared_content_unchanged(
            payload.cells,
            current_content.filter((entry): entry is NonNullable<typeof entry> => entry !== undefined),
        )) return refused('document-changed');

        const highlight_patches = replay_highlight_patches(highlights.map((highlight) => ({
            sheetIndex: payload.highlightSheetIndices.get(highlight.ordinal) ?? -1,
            sourceRow: highlight.sourceRow,
            sourceColumn: highlight.sourceColumn,
            expected: highlight.expected,
            desired: highlight.desired,
        })));
        if (highlight_patches.some((patch) => patch.sheetIndex < 0)) {
            return refused('proposal-mismatch');
        }

        const committed_cells = Object.freeze(writes.map((write) => Object.freeze({
            ordinal: write.ordinal,
            resolvedSheetIndex: write.sheetIndex,
            key: write.key,
            entry: write.entry,
        })));
        // The row mapping is source-owned, not pending-state-owned, so resolving
        // it before the durable CAS is safe. Keeping the exact terminal material
        // available here lets the updater size the complete response before it
        // authorizes the corresponding state transition.
        const display_focus = resolve_replay_display_focus(
            payload,
            (sheet_index, source_row) => replay_core.display_row_for_source(
                sheet_index,
                source_row,
            ),
            replay_core.mapping_generation(payload.focusSheetIndex),
        );

        // The compare-and-swap. `conflict` is reported by the updater rather than
        // thrown, because a conflict is an ordinary outcome — someone typed while
        // the replay was in flight — and must leave history exactly where it is.
        let conflicted = false;
        let unavailable = false;
        let committed_structures: readonly HistoryReplayAcceptedStructuralWrite[] | undefined;
        await update_file_state((current, updater_sheets) => {
            conflicted = false;
            unavailable = false;
            committed_structures = undefined;
            if (!payload.isCurrent()) {
                unavailable = true;
                return current;
            }
            // Re-verified INSIDE the updater, which is what makes the check
            // atomic with the write: `update_file_state` retries against a fresh
            // snapshot when an unrelated writer wins, and a comparison made
            // before the loop would then be authorizing a write against state
            // that has moved.
            const identities = updater_sheets.map(worksheet_identity);
            if (
                !replay_overlays_match_durable(current, payload.cells, identities)
                || !replay_highlights_match_durable(
                    current,
                    highlights,
                    payload.highlightSheetIndices,
                    identities,
                )
                || !replay_structures_match_durable(
                    current,
                    payload.structures,
                    identities,
                )
            ) {
                conflicted = true;
                return current;
            }
            let next = current;
            const by_sheet = new Map<number, (typeof writes)[number][]>();
            for (const write of writes) {
                const sheet_writes = by_sheet.get(write.sheetIndex);
                if (sheet_writes === undefined) by_sheet.set(write.sheetIndex, [write]);
                else sheet_writes.push(write);
            }
            const structure_by_sheet = new Map(payload.structures.map(
                (structural) => [structural.resolvedSheetIndex, structural] as const,
            ));
            const changed_sheet_indices = new Set([
                ...by_sheet.keys(),
                ...structure_by_sheet.keys(),
            ]);
            try {
                const canonical_before = reconciled_against(
                    { revision: 0, state: current },
                    src,
                    false,
                ).state as PerFileState;
                for (const sheet_index of changed_sheet_indices) {
                    const sheet_writes = by_sheet.get(sheet_index) ?? [];
                    const sheet = identities[sheet_index];
                    const durable_structural = own_pending_structural_changes(
                        pending_changes_for_sheet(
                            next.pendingEdits,
                            sheet_index,
                            sheet?.name,
                            sheet?.worksheetId,
                        ) ?? {},
                    );
                    const cells = pending_edits_for_sheet(
                        next.pendingEdits,
                        sheet_index,
                        sheet?.name,
                        sheet?.worksheetId,
                    );
                    const updated = pending_edits_with_replay_writes(cells, sheet_writes);
                    const structural = structure_by_sheet.get(sheet_index)?.desired
                        ?? durable_structural;
                    const pending_ids = new Set(structural.appendedRows.map((row) => row.id));
                    const removal_ids = new Set(structural.tailRemovals.map(
                        (removal) => removal.appendHistoryId,
                    ));
                    // Start from the authenticated durable diagnostics, never the
                    // renderer's desired array. Formula diagnostics are derived
                    // afresh below. Other diagnostics survive only for structural
                    // identities the prospective state still contains.
                    const retained_conflicts = durable_structural.conflicts.flatMap(
                        (conflict): PendingStructuralConflict[] => {
                            if (conflict.reason === 'ambiguousPendingFormula') return [];
                            const pendingRowIds = conflict.pendingRowIds.filter(
                                (id) => pending_ids.has(id),
                            );
                            const tailRemovalIds = conflict.tailRemovalIds.filter(
                                (id) => removal_ids.has(id),
                            );
                            if (pendingRowIds.length === 0 && tailRemovalIds.length === 0) {
                                return [];
                            }
                            return [{
                                ...conflict,
                                pendingRowIds,
                                tailRemovalIds,
                            }];
                        },
                    );
                    const prospective = {
                        cells: updated ?? {},
                        formatTemplates: structural.formatTemplates,
                        appendedRows: structural.appendedRows,
                        tailRemovals: structural.tailRemovals,
                        ...(structural.appendBasis === undefined
                            ? {}
                            : { appendBasis: structural.appendBasis }),
                        conflicts: retained_conflicts,
                    };
                    // The conflict reserve is host-only. Measure the complete
                    // renderer-owned worksheet envelope, including live cell
                    // overlays combined with the replayed row state, before a
                    // canonical diagnostic is allowed to occupy the reserve.
                    assert_pending_user_changes_encoded_bound({
                        sheetIndex: sheet_index,
                        ...(sheet?.name === undefined ? {} : { sheetName: sheet.name }),
                        ...(sheet?.worksheetId === undefined
                            ? {}
                            : { worksheetId: sheet.worksheetId }),
                        ...prospective,
                        conflicts: [],
                    });
                    next = {
                        ...next,
                        pendingEdits: with_pending_changes_for_sheet(
                            next.pendingEdits,
                            sheet_index,
                            prospective,
                            sheet?.name,
                            sheet?.worksheetId,
                        ),
                    };
                }

                // Reconcile the prospective transaction against the same source
                // that owns the replay lease. This recomputes formula, schema,
                // and template diagnostics from host-readable facts. A renderer
                // must have predicted that canonical result exactly in every
                // structural arm; it cannot mint or suppress a host conflict.
                const canonical = reconciled_against(
                    { revision: 0, state: next },
                    src,
                    false,
                ).state as PerFileState;
                const canonical_structures: HistoryReplayAcceptedStructuralWrite[] =
                    payload.structures.map((structural) => {
                    const sheet = identities[structural.resolvedSheetIndex];
                    const desired = own_pending_structural_changes(
                        pending_changes_for_sheet(
                            canonical.pendingEdits,
                            structural.resolvedSheetIndex,
                            sheet?.name,
                            sheet?.worksheetId,
                        ) ?? {},
                    );
                    if (JSON.stringify(desired) !== JSON.stringify(structural.desired)) {
                        throw new Error('noncanonical replay conflict overlay');
                    }
                    return Object.freeze({
                        ordinal: structural.ordinal,
                        resolvedSheetIndex: structural.resolvedSheetIndex,
                        expected: structural.expected,
                        desired,
                    });
                });
                const structural_indices = new Set(payload.structures.map(
                    (structural) => structural.resolvedSheetIndex,
                ));
                const derived_structures: HistoryReplayAcceptedStructuralWrite[] = [];
                for (let sheet_index = 0; sheet_index < identities.length; sheet_index += 1) {
                    if (structural_indices.has(sheet_index)) continue;
                    const sheet = identities[sheet_index];
                    const before = own_pending_structural_changes(pending_changes_for_sheet(
                        canonical_before.pendingEdits,
                        sheet_index,
                        sheet?.name,
                        sheet?.worksheetId,
                    ) ?? {});
                    const after = own_pending_structural_changes(pending_changes_for_sheet(
                        canonical.pendingEdits,
                        sheet_index,
                        sheet?.name,
                        sheet?.worksheetId,
                    ) ?? {});
                    if (JSON.stringify(before) === JSON.stringify(after)) continue;
                    const without_conflicts = (value: PendingStructuralChanges) => ({
                        formatTemplates: value.formatTemplates,
                        appendedRows: value.appendedRows,
                        tailRemovals: value.tailRemovals,
                        ...(value.appendBasis === undefined
                            ? {}
                            : { appendBasis: value.appendBasis }),
                    });
                    // A replay may make a formula diagnostic on a sibling sheet
                    // appear or disappear. That transition is derived from the
                    // atomically verified workbook, not chosen by the renderer.
                    // No sibling row/template/basis mutation gets the same
                    // privilege: those still require an explicit leased arm.
                    if (JSON.stringify(without_conflicts(before))
                        !== JSON.stringify(without_conflicts(after))) {
                        throw new Error('unnamed replay structural mutation');
                    }
                    derived_structures.push(Object.freeze({
                        ordinal: payload.structures.length + derived_structures.length,
                        resolvedSheetIndex: sheet_index,
                        hostDerived: true,
                        expectedConflicts: before.conflicts,
                        desiredConflicts: after.conflicts,
                    }));
                }
                next = canonical;
                committed_structures = Object.freeze([
                    ...canonical_structures,
                    ...derived_structures,
                ]);
            } catch {
                conflicted = true;
                return current;
            }
            for (const patch of highlight_patches) {
                try {
                    const highlights_next = apply_cell_highlight_patch(
                        next.cellHighlights,
                        patch,
                        { sheets: updater_sheets } as WorkbookMeta,
                        physical_digest,
                    );
                    if (cell_highlight_states_equal(next.cellHighlights, highlights_next)) continue;
                    next = { ...next, cellHighlights: highlights_next };
                } catch {
                    // Out of range, or over the per-file cap. Either way the
                    // replay cannot be applied as recorded, and applying the rest
                    // would leave half an undo.
                    unavailable = true;
                    return current;
                }
            }
            try {
                // Ingress bounds are not enough: a cell commit and a structural
                // preparation arrive separately, and canonical sibling conflict
                // patches are created only here. Bound the exact prospective
                // terminal while refusal can still leave the durable snapshot
                // untouched.
                assert_json_encoded_bound({
                    requestId: request.requestId,
                    replayId: request.replayId,
                    leaseId: request.leaseId,
                    mutationId: request.mutationId,
                    sourceGeneration: payload.sourceGeneration,
                    cells: committed_cells,
                    structures: committed_structures,
                    focusSheetIndex: payload.focusSheetIndex,
                    focus: payload.focus,
                    displayFocus: display_focus,
                }, MAX_HISTORY_ACTION_ENCODED_BYTES);
            } catch {
                unavailable = true;
                committed_structures = undefined;
                return current;
            }
            return next;
        }, undefined, payload.isCurrent, {
            expectedAuthorityRevision: expected_authority,
            expectedPhysicalRevision: source_authority.physicalRevision,
        });

        if (unavailable) return refused('unavailable');
        if (conflicted) return refused('conflict');
        if (committed_structures === undefined) return refused('conflict');
        if (!payload.isCurrent()) return refused('document-changed');
        if (!accept_replay_row_admissions(
            payload.rowAdmissionRequestIds,
            request.leaseId,
        )) return refused('conflict');
        // An unchanged updater reports `undefined` — for a replay that means the document
        // already held everything the replay would write, a byte-identical redo of
        // a gesture that changed nothing durable, which is a success and not a
        // refusal. Highlight publication happens only after the caller posts this
        // terminal, so renderer store CASes cannot be pre-empted by a refresh.
        return Object.freeze({
            requestId: request.requestId,
            replayId: request.replayId,
            leaseId: request.leaseId,
            mutationId: request.mutationId,
            sourceGeneration: payload.sourceGeneration,
            cells: committed_cells,
            structures: committed_structures,
            focusSheetIndex: payload.focusSheetIndex,
            focus: payload.focus,
            // Resolved HERE and not at preparation: a replay waits on a keypress
            // and a round trip, and a transform queued in that window would make a
            // preparation-time answer name rows the user is no longer looking at.
            // Serialized commands mean anything queued after this point publishes
            // after the commit, and the generation stamp is what lets the renderer
            // decline a projection that was overtaken anyway.
            displayFocus: display_focus,
        });
    }

    /** Whether every prepared cell still holds the overlay the request reported. */
    function replay_overlays_match_durable(
        current: PerFileState,
        cells: readonly HistoryReplayPreparedCell[],
        sheets: readonly WorksheetIdentity[],
    ): boolean {
        // One map read per sheet rather than per cell: `pending_edits_for_sheet`
        // walks the slot to answer, and a wide gesture would walk it thousands of
        // times.
        const by_sheet = new Map<number, SheetPendingEditCells | undefined>();
        for (const cell of cells) {
            const index = cell.resolvedSheetIndex;
            if (!by_sheet.has(index)) {
                const sheet = sheets[index];
                by_sheet.set(index, pending_edits_for_sheet(
                    current.pendingEdits,
                    index,
                    sheet?.name,
                    sheet?.worksheetId,
                ));
            }
            if (!replay_cell_matches(by_sheet.get(index), {
                sheetIndex: index,
                sourceRow: cell.sourceRow,
                sourceColumn: cell.sourceColumn,
                overlay: cell.overlay,
                persisted: cell.persisted,
                persistedHyperlink: cell.persistedHyperlink,
            })) return false;
        }
        return true;
    }

    /** Whether every leased worksheet still holds its complete structural arm. */
    function replay_structures_match_durable(
        current: PerFileState,
        structures: readonly (HistoryReplayStructuralInput & {
            readonly resolvedSheetIndex: number;
        })[],
        sheets: readonly WorksheetIdentity[],
    ): boolean {
        for (const structural of structures) {
            const sheet = sheets[structural.resolvedSheetIndex];
            const actual = own_pending_structural_changes(pending_changes_for_sheet(
                current.pendingEdits,
                structural.resolvedSheetIndex,
                sheet?.name,
                sheet?.worksheetId,
            ) ?? {});
            if (JSON.stringify(actual) !== JSON.stringify(structural.expected)) return false;
        }
        return true;
    }

    /** Whether prospective replay rows make an authored A1 formula ambiguous. */
    function replay_structures_have_ambiguous_pending_formulas(
        current: PerFileState,
        structures: readonly ResolvedReplayStructure[],
        sheets: readonly SheetMeta[],
        writes: readonly ReplayCellWrite[] = [],
        include_source_cells = true,
    ): boolean {
        if (!file_path.toLowerCase().endsWith('.xlsx')) return false;
        const desired_by_sheet = new Map(structures.map(
            (structural) => [structural.resolvedSheetIndex, structural.desired] as const,
        ));
        const structural_by_sheet = sheets.map((sheet, sheet_index) =>
            desired_by_sheet.get(sheet_index) ?? own_pending_structural_changes(
                pending_changes_for_sheet(
                    current.pendingEdits,
                    sheet_index,
                    sheet.name,
                    sheet.worksheetId,
                ) ?? {},
            ));
        const writes_by_sheet = new Map<number, ReplayCellWrite[]>();
        for (const write of writes) {
            const entries = writes_by_sheet.get(write.sheetIndex) ?? [];
            entries.push(write);
            writes_by_sheet.set(write.sheetIndex, entries);
        }
        for (let formula_index = 0; formula_index < sheets.length; formula_index += 1) {
            const formula_sheet = sheets[formula_index]!;
            const current_cells = include_source_cells
                ? pending_edits_for_sheet(
                    current.pendingEdits,
                    formula_index,
                    formula_sheet.name,
                    formula_sheet.worksheetId,
                )
                : undefined;
            const prospective_cells = include_source_cells
                ? pending_edits_with_replay_writes(
                    current_cells,
                    writes_by_sheet.get(formula_index) ?? [],
                ) ?? {}
                : {};
            for (let target_index = 0; target_index < sheets.length; target_index += 1) {
                if (pending_formula_cells_referencing_provisional_rows(
                    structural_by_sheet[formula_index]!,
                    prospective_cells,
                    structural_by_sheet[target_index]!,
                    formula_index,
                    target_index,
                    sheets,
                ).length > 0) return true;
            }
        }
        return false;
    }

    /** Structural replay writes stay current and inside authority already issued. */
    async function replay_structures_are_authorized(
        structures: readonly ResolvedReplayStructure[],
        replay_source: DataSource,
        additionally_authorized: ReadonlySet<string> = new Set(),
    ): Promise<boolean> {
        const edit_session_id = active_edit_session_id;
        if (structures.length > 0 && edit_session_id === undefined) return false;
        const is_xlsx = file_path.toLowerCase().endsWith('.xlsx');
        let xlsx_bytes: Uint8Array | undefined;
        if (is_xlsx && structures.some(
            (structural) => structural.desired.tailRemovals.length > 0,
        )) {
            try {
                xlsx_bytes = await host.fs.read_file(uri);
            } catch {
                return false;
            }
        }
        // History can retain a row after it leaves the durable Pending Changes
        // leaf. A source refresh therefore cannot reconcile that state in
        // place. Validate every desired structural arm against the source that
        // this replay lease will bind before consulting the retained capability.
        try {
            for (const structural of structures) {
                const desired = structural.desired;
                const sheet = replay_source.meta().sheets[structural.resolvedSheetIndex];
                if (sheet === undefined) return false;
                if (desired.appendedRows.length > 0 && desired.appendBasis === undefined) {
                    return false;
                }
                if (
                    desired.appendBasis !== undefined
                    && (
                        desired.appendBasis.columnCount !== sheet.columnCount
                        || desired.appendBasis.schemaFingerprint
                            !== worksheet_append_schema_fingerprint(sheet)
                    )
                ) return false;
                if (
                    sheet.sourceRowCount - desired.tailRemovals.length < 0
                    || sheet.sourceRowCount - desired.tailRemovals.length
                        + desired.appendedRows.length
                        > append_row_ceiling_for(profile)
                ) return false;
                const retained_row_count = sheet.sourceRowCount
                    - desired.tailRemovals.length;
                if (desired.tailRemovals.some(
                    (removal, index) => removal.sourceRow !== retained_row_count + index,
                )) return false;
                if (desired.appendedRows.some((row) => (
                    Object.keys(row.cells).some((column) => Number(column) >= sheet.columnCount)
                    || Object.keys(row.highlights ?? {}).some(
                        (column) => Number(column) >= sheet.columnCount,
                    )
                ))) return false;
                for (const template of desired.formatTemplates) {
                    if (!is_xlsx) {
                        if (template.format.kind !== 'none') return false;
                        continue;
                    }
                    if (
                        template.format.kind !== 'xlsx'
                        || template.format.cellStyleIndexes.length !== sheet.columnCount
                        || replay_source.append_style_dependency_fingerprint === undefined
                        || template.format.styleFingerprint
                            !== replay_source.append_style_dependency_fingerprint(
                                template.format.cellStyleIndexes,
                                template.format.rowStyleIndex,
                            )
                    ) return false;
                }
                if (
                    is_xlsx
                    && desired.appendedRows.length > 0
                    && desired.appendBasis !== undefined
                    && desired.formatTemplates.some((template) => (
                        template.format.kind !== 'xlsx'
                        || desired.appendBasis!.styleFingerprint
                            !== template.format.styleFingerprint
                    ))
                ) return false;
                for (const removal of desired.tailRemovals) {
                    const current_format: PendingRowFormat = is_xlsx
                        ? capture_xlsx_append_row_format(
                            xlsx_bytes!,
                            structural.resolvedSheetIndex,
                            removal.sourceRow + 1,
                            sheet.columnCount,
                            sheet.excelFirstRowHeader?.active === true
                                ? sheet.excelFirstRowHeader.sourceRow
                                : undefined,
                        )
                        : { kind: 'none' };
                    const current = saved_row_physical_fingerprint({
                        cells: source_row_cells_for_fingerprint(
                            replay_source,
                            structural.resolvedSheetIndex,
                            removal.sourceRow,
                        ),
                        format: current_format,
                    });
                    if (current !== saved_row_physical_fingerprint(removal.savedRow)) {
                        return false;
                    }
                }
            }
        } catch {
            return false;
        }
        // Validate the whole request before admitting retained rows into any
        // ledger, so one invalid worksheet cannot partially mutate authority.
        for (const structural of structures) {
            const target = canonical_worksheet_target({
                ...structural.worksheet,
                sheetIndex: structural.resolvedSheetIndex,
            });
            if (target === undefined || edit_session_id === undefined) return false;
            const ledger_key = append_ledger_key(edit_session_id, target);
            const live_ledger = append_admission_ledgers.get(ledger_key);
            if (!accepted_row_admission_gestures_are_complete(
                ledger_key,
                structural.desired.appendedRows,
            )) return false;
            if (changes_use_unsettled_row_authority(
                live_ledger,
                ledger_key,
                structural.desired.appendedRows,
                structural.desired.formatTemplates,
                structural.desired.appendBasis,
                additionally_authorized,
            )) return false;
            const ledger = live_ledger === undefined
                ? undefined
                : clone_append_admission_ledger(live_ledger);
            const retained_templates = project_retained_pending_rows(
                ledger,
                target,
                structural.desired.appendedRows,
            );
            if (!appended_rows_match_ledger(ledger, structural.desired.appendedRows)) return false;
            if (structural.desired.formatTemplates.some((template) => {
                const issued = retained_templates.get(template.id)
                    ?? issued_append_template(
                        ledger,
                        ledger_key,
                        template.id,
                        additionally_authorized,
                    );
                return issued === undefined
                    || JSON.stringify(issued) !== JSON.stringify(template);
            })) return false;
            const provisional_basis = accepted_append_basis_for_ledger(
                ledger,
                ledger_key,
                additionally_authorized,
            );
            if (
                structural.desired.appendBasis !== undefined
                && JSON.stringify(structural.desired.appendBasis)
                    !== JSON.stringify(provisional_basis)
            ) return false;
            if (structural.desired.tailRemovals.some(
                (removal) => !tail_removal_matches_authority(target, removal),
            )) return false;
        }
        return true;
    }

    /** Whether every prepared highlight still holds its expected colour. */
    function replay_highlights_match_durable(
        current: PerFileState,
        highlights: readonly HistoryReplayHighlightInput[],
        sheet_indices: ReadonlyMap<number, number>,
        sheets: readonly WorksheetIdentity[],
    ): boolean {
        const digest = source_authority.physicalDigest;
        if (digest === undefined) return false;
        const renderable = normalize_workbook_snapshot_state(
            current,
            { sheets } as WorkbookMeta,
            digest,
        ).cellHighlights;
        for (const highlight of highlights) {
            const index = sheet_indices.get(highlight.ordinal);
            if (index === undefined) return false;
            if (!replay_highlight_matches(
                renderable?.sheets[index]?.cells,
                {
                    sheetIndex: index,
                    sourceRow: highlight.sourceRow,
                    sourceColumn: highlight.sourceColumn,
                    expected: highlight.expected,
                    desired: highlight.desired,
                },
            )) return false;
        }
        return true;
    }

    /**
     * Whether the file still holds the bytes this session parsed.
     *
     * The save path's sequence, for the same reason: stat, read, re-stat, compare
     * the digest and the authority. The two stats bracket the read so a write
     * landing mid-read is caught rather than digested.
     *
     * The residual race is accepted and is the same one the save path documents.
     * The commit repeats this check and spells out exactly what the repetition
     * does and does not close; see the comment above its call.
     */
    async function replay_physical_source_is_current(
        current_source: DataSource,
        observation: Readonly<PhysicalSourceObservation>,
        expected_digest: string,
        expected_authority: number,
        is_cancelled: () => boolean,
    ): Promise<boolean> {
        try {
            const before = await host.fs.stat(uri);
            if (`${before.mtime}:${before.size}` !== observation.fingerprint) return false;
            if (observation.verification === 'bracketedDigest') {
                return observation.digest === expected_digest
                    && current_source.physical_content_matches !== undefined
                    && await current_source.physical_content_matches(
                        expected_digest,
                        is_cancelled,
                    )
                    && source_authority.authorityRevision === expected_authority
                    && expected_authority
                        === file_coordinator.authority().authorityRevision;
            }
            const raw = await host.fs.read_file(uri);
            const after = await host.fs.stat(uri);
            return before.mtime === after.mtime
                && before.size === after.size
                && content_digest(raw) === expected_digest
                && source_authority.authorityRevision === expected_authority
                && expected_authority === file_coordinator.authority().authorityRevision;
        } catch {
            // An unreadable file is not a current one. Refusing is right either
            // way: a replay that cannot verify its basis must not mutate.
            return false;
        }
    }

    async function establish_pending_edit_flush_boundary(
        request_prefix: string,
    ): Promise<{ editSessionId?: string; sequence: number }> {
        const protocol_epoch = renderer_protocol_epoch;
        const request_id = `${request_prefix}:${++next_pending_edit_flush_request}`;
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
            // of the first drain, so the boundary is stable only after a second drain.
            await drain_controller();
            return flushed;
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
            return await Promise.race([handshake, timeout]);
        } finally {
            scheduler.clearTimeout(timeout_handle);
        }
    }

    async function flush_pending_edits(): Promise<void> {
        stop_edit_admission();
        if (!editing_supported || !renderer_ready) {
            await drain_controller();
            return;
        }
        await establish_pending_edit_flush_boundary('vscode-close');
    }

    async function drain_controller(): Promise<void> {
        for (;;) {
            const edit_tail = pending_edit_writes;
            const save_tail = active_save_drain;
            const disposal_release_tail = disposal_edit_release_drain;
            const layout_tail = layout_write_tail;
            const append_tail = append_admission_tails.get(
                APPEND_ADMISSION_AUTHORITY_TAIL,
            );
            const transform_tails = [...transform_commit_barriers]
                .map((barrier) => barrier.completion);
            const compare_tails = [...compare_diff_sidecars];
            const drain_work: Array<{
                readonly kind: string;
                readonly completion: Promise<unknown>;
            }> = [
                { kind: 'editWrites', completion: edit_tail },
                { kind: 'save', completion: save_tail },
                { kind: 'disposalRelease', completion: disposal_release_tail },
                { kind: 'layoutWrite', completion: layout_tail },
                ...transform_tails.map((completion) => ({
                    kind: 'transformCommit',
                    completion,
                })),
                ...compare_tails.map((completion) => ({
                    kind: 'compareDiff',
                    completion,
                })),
            ];
            if (append_tail !== undefined) {
                drain_work.push({ kind: 'appendAdmission', completion: append_tail });
            }
            options.integrationTestPort?.on_controller_drain_wait?.(
                Object.freeze(drain_work.map(({ kind }) => kind)),
            );
            await Promise.all(drain_work.map(({ completion }) => completion));
            if (
                edit_tail === pending_edit_writes
                && save_tail === active_save_drain
                && disposal_release_tail === disposal_edit_release_drain
                && layout_tail === layout_write_tail
                && append_tail === append_admission_tails.get(
                    APPEND_ADMISSION_AUTHORITY_TAIL,
                )
                && transform_commit_barriers.size === 0
                && compare_diff_sidecars.size === 0
            ) return;
        }
    }

    return {
        select_sheet,
        refresh_if_changed,
        stop_edit_admission,
        flush_pending_edits,
        drain: drain_controller,
        dispose() {
            if (disposed) return;
            disposed = true;
            renderer_ready = false;
            for (const request of pending_sheet_selections) {
                request.reject(new Error(
                    'Viewer controller was disposed before the worksheet could be selected.',
                ));
            }
            pending_sheet_selections.clear();
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
            // Nothing can be spent or answered after disposal, and `disposed` is
            // already part of every lease's currency predicate. Cleared so the
            // registry's retained answers do not outlive the panel.
            cleanup(() => replay_leases.clear());
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
