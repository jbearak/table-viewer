import { createHash } from 'crypto';
import { CsvDataSource } from './data-source/csv-source';
import {
    build_source_from_buffer,
    csv_source_from_buffer,
} from './data-source/from-buffer';
import { ExcelHeaderDataSource } from './data-source/excel-header-source';
import type {
    DataSource,
    SheetMeta,
    WorkbookMeta,
} from './data-source/interface';
import {
    projected_row_for_source,
    read_source_rows_indexed,
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
} from './spreadsheet-safety';
import { prepare_csv_serializer } from './serialize-csv';
import { write_xlsx_workbook_cell_edits } from './xlsx-package';
import type { XlsxCellEdit } from './xlsx-cell-write';
import { validate_dirty_bases } from './csv-base-validation';
import { cell_edit_base } from './cell-edit-model';
import { get_raw_cell_text } from './cell-display';
import { cell_key, parse_cell_key } from './cell-key';
import type { CellHyperlink, RichText } from './cell-content';
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
    pending_edits_for_sheet,
    reconcile_pending_edit_sheets,
    sanitize_excel_header_overrides,
    sheet_name_from_transform_schema,
    transform_has_entries,
    transform_is_active,
    transform_schema_for_sheet,
    with_pending_edits_for_sheet,
    worksheet_identity,
    worksheet_target_index,
    worksheet_target_key,
    worksheet_target_lookup,
    worksheet_target_matches,
    type ActiveCsvSaveLifecycle,
    type CsvDirtyMap,
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
    type WorksheetTarget,
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
    type HistoryReplayFocus,
    type HistoryReplayHighlightInput,
    type HistoryReplayPrepareRefused,
    type HistoryReplayPreparedCell,
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
}

export interface SavePlanInput {
    readonly source: DataSource;
    readonly file_path: string;
    readonly worksheets: readonly SavePlanWorksheetInput[];
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
    for (const [source_row, cols] of cols_by_source_row) {
        const projected = projected_row_for_source(src, sheet_index, source_row);
        if (projected === undefined) continue;
        const entry = by_projected_row.get(projected);
        // Two source rows projecting to one row is not expected, but merging
        // rather than overwriting keeps every requested column observable.
        if (entry) entry.cols.push(...cols);
        else by_projected_row.set(projected, { source_row, cols });
    }
    const projected_rows = [...by_projected_row.keys()].sort((a, b) => a - b);
    for (let start = 0; start < projected_rows.length; start += SAVE_WINDOW) {
        const batch = projected_rows.slice(start, start + SAVE_WINDOW);
        const { rows } = read_source_rows_indexed(src, sheet_index, batch);
        batch.forEach((projected, offset) => {
            const entry = by_projected_row.get(projected)!;
            const row = rows[offset] ?? [];
            for (const col of entry.cols) {
                const cell = row[col];
                if (cell === undefined) continue;
                const cell_key = `${entry.source_row}:${col}`;
                observed_bases.set(
                    cell_key,
                    cell === null ? '' : cell_edit_base(cell).text,
                );
                if (cell !== null) {
                    const rich = cell_edit_base(cell).rich;
                    if (rich) observed_rich.set(cell_key, rich);
                }
                observed_links.set(cell_key, cell?.hyperlink ?? null);
            }
        });
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
    const planned = input.worksheets.map(({ sheet_index, edits, wanted_bases, dirty_edits }) => {
        const {
            texts: observed_bases,
            rich: observed_rich,
            links: observed_links,
        } = harvest_source_bases(src, sheet_index, wanted_bases);
        const cell_edits: XlsxCellEdit[] = [];
        for (const [key, value] of Object.entries(edits)) {
            const [row, col] = key.split(':').map(Number);
            if (!Number.isInteger(row) || !Number.isInteger(col)) continue;
            // A styled edit carries its runs through to the package writer.
            // `validate_edit_cells` already required the runs' concatenated text
            // to equal `value`, so the plain projection and the rich form cannot
            // disagree by the time they get here.
            const runs = dirty_edits?.[key]?.valueRuns?.runs;
            cell_edits.push(runs && runs.length > 0 ? { row, col, value, runs } : { row, col, value });
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
        return {
            observed_bases,
            observed_rich,
            observed_links,
            sheetIndex: sheet_index,
            edits: cell_edits,
            link_edits,
        };
    });
    return {
        observed_bases: planned.map(({ observed_bases }) => observed_bases),
        observed_rich: planned.map(({ observed_rich }) => observed_rich),
        observed_links: planned.map(({ observed_links }) => observed_links),
        produce: (raw) => write_xlsx_workbook_cell_edits(raw, planned),
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
    const { edits, wanted_bases } = input.worksheets[0];
    const sheet = src.meta().sheets[0];
    if (!sheet) throw new Error('CSV source has no worksheet.');

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

    const row_count = sheet.rowCount;
    let start = 0;
    while (start < row_count) {
        const window = src.read_rows(0, start, SAVE_WINDOW);
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

    // Eager rather than inside `produce`: the caller reads `observed_bases`
    // immediately and allocation failures remain planning failures. Build the
    // producer in a separate scope so it retains only the final bytes, never the
    // chunk array or source windows used to assemble them.
    const bytes = concatenate_csv_chunks(chunks);
    return {
        observed_bases: [observed_bases],
        produce: fixed_csv_bytes_producer(bytes),
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
        build_source: csv_source_builder(config),
    };
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
        /** Each prepared highlight's resolved sheet, by ordinal. */
        readonly highlightSheetIndices: ReadonlyMap<number, number>;
        readonly focus: HistoryReplayFocus;
        readonly focusSheetIndex: number;
        readonly sourceGeneration: number;
        /** Whether the host state the lease was bound to is still in place. */
        readonly isCurrent: () => boolean;
    }
    const replay_leases = create_history_replay_lease_registry<
        ReplayLeasePayload,
        HistoryReplayCommitted | HistoryReplayCommitRefused
    >();
    let replay_preparation_in_flight = false;
    /**
     * The commit operation a taken lease is running, so a retransmission can join
     * the one mutation instead of waiting on an answer that may never come.
     */
    let active_replay_commit:
        | Promise<HistoryReplayCommitted | HistoryReplayCommitRefused>
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
    ): Readonly<FileStateSnapshot> {
        const state = snapshot.state as PerFileState;
        if (!state.pendingEdits) return snapshot;
        const reconciled = reconcile_pending_edit_sheets(
            state.pendingEdits,
            next.meta().sheets,
        );
        if (reconciled === state.pendingEdits) return snapshot;
        if (reconciled) {
            return { revision: snapshot.revision, state: { ...state, pendingEdits: reconciled } };
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
        const release = Symbol(file_key);
        file_edit_state.phase = {
            type: 'releasing',
            release,
            token: edit_session_token,
        };
        notify_edit_state();
        return { release, admittedWrites: pending_edit_writes };
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
            projected_slots.push(projected
                ? {
                    ...(slot.sheetName !== undefined ? { sheetName: slot.sheetName } : {}),
                    ...(slot.worksheetId !== undefined
                        ? { worksheetId: slot.worksheetId }
                        : {}),
                    cells: projected,
                }
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
            rejection: validation.type === 'removedRows'
                ? { reason: 'rowsRemoved', worksheetOperationIndex: 0, keys: validation.keys }
                : { reason: 'baseMismatch', worksheetOperationIndex: 0, keys: validation.keys },
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
                                });
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
                next = with_pending_edits_for_sheet(
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
                        const adopted = adopt_committed_candidate(
                            candidate,
                            committed,
                            request.seq,
                            reason,
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

    function parse_save_operation(input: unknown): ParsedSaveOperation {
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
            const maps = sanitized_wire_save_maps(
                requested.edits,
                requested.dirtyEdits,
            );
            if (!target || !maps) return malformed();
            const target_key = worksheet_target_key(target);
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
        const committed = await update_file_state((current) => {
            let pending = current.pendingEdits;
            operation.identity.worksheets.forEach((worksheet, index) => {
                const target = operation.durableTargets[index];
                // Already sanitized: `operation.identity` is the owned operation
                // built by `parse_save_operation` after its complete dirty maps
                // passed the wire boundary.
                pending = with_pending_edits_for_sheet(
                    pending,
                    target.sheetIndex,
                    { ...worksheet.dirtyEdits },
                    target.sheetName,
                    target.worksheetId,
                );
            });
            return { ...current, pendingEdits: pending };
        }, undefined, () => save_operation_is_current(operation));
        if (!committed || !save_operation_is_current(operation)) {
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
        if (
            edit_cleanup_blocked()
            || transform_work_in_flight()
            || !editing_supported
            || !src
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
                    : 'The table view is still refreshing. Please try saving again.',
            );
            void post_to_receiver({ type: 'saveResult', success: false, lifecycle });
            return;
        }

        let plan: SavePlan;
        try {
            plan = profile.plan_save({
                source: src,
                file_path,
                worksheets: identity.worksheets.map((worksheet) => ({
                    sheet_index: worksheet.sheetIndex,
                    edits: worksheet.edits,
                    wanted_bases: new Set(Object.keys(worksheet.dirtyEdits)),
                    dirty_edits: worksheet.dirtyEdits,
                })),
            });
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
                : { type: 'baseMismatch' as const, keys: Object.keys(worksheet.dirtyEdits) };
            if (validation.type === 'valid') continue;
            rejection = validation.type === 'removedRows'
                ? { reason: 'rowsRemoved', worksheetOperationIndex: index, keys: validation.keys }
                : { reason: 'baseMismatch', worksheetOperationIndex: index, keys: validation.keys };
            break;
        }
        if (rejection) {
            // Same shape as the sibling early-returns above: a begin/finish pair so
            // the webview sees a terminal 'failed' lifecycle for this exact
            // operation and restores the precise dirty map it submitted.
            const active = begin_save_lifecycle(identity);
            const lifecycle = finish_save_lifecycle(active.operation, 'failed');
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
        let post_save_reservation: { cancel(): void } | undefined;
        try {
            await pending_edit_writes.catch(() => {});
            if (!save_may_continue(operation)) return;
            await persist_accepted_save(operation);
            operation.phase = 'accepted';

            // Shared refusal path: the adopted-source check, full verification,
            // and final pre-write re-stat must report a conflict identically, so a
            // detected race never surfaces as a generic "Failed to save" error.
            const refuse_as_external_change = async (): Promise<void> => {
                show_owner_warning(
                    'File was modified externally. Please review the changes and try again.',
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
                basesValidated: true,
            });
            return;
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
        });
        notify_edit_state();

        void refresh_subscription.request('postSave').catch((error) => {
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
                if (edit_state) update_session_state_material(edit_state);
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
                        (edit_state?.state as PerFileState | undefined)?.pendingEdits,
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
            case 'pendingEditsChanged': {
                if (!editing_supported) return;
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
                if (replay_preparation_in_flight || replay_leases.current(Date.now()) !== undefined) {
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
                    void post_to_receiver(
                        history_replay_result_message(decision.settled.result),
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
                    void post_to_receiver(
                        history_replay_result_message(await running),
                        receiver_epoch,
                    );
                    return;
                }
                const operation = run_history_replay_commit(request, decision.lease.payload);
                void post_to_receiver(
                    history_replay_result_message(await operation),
                    receiver_epoch,
                );
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
        const lease = replay_leases.issue(
            {
                leaseId: `${request.requestId}:${now}`,
                requestId: request.requestId,
                replayId: request.replayId,
            },
            {
                cells: Object.freeze(prepared_cells),
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
        // Awaited, unlike most posts here: the lease is already live, and a
        // renderer that never learned its id can neither spend nor abandon it —
        // it would hold the one-at-a-time slot and refuse every replay as `busy`
        // until its TTL ran out. Abandoning on a failed delivery is what keeps the
        // slot's occupancy tied to a renderer that actually knows about it.
        const delivered = await post_to_receiver({
            type: 'historyReplayPrepared',
            prepared: {
                requestId: request.requestId,
                replayId: request.replayId,
                leaseId: lease.leaseId,
                focusSheetIndex: focus_sheet_index,
                focus: request.focus,
                cells: Object.freeze(prepared_cells),
            },
        }, receiver_epoch);
        // Conditional on this exact lease, so a newer one issued in the meantime
        // is never the thing dropped.
        if (!delivered && replay_leases.current(Date.now())?.leaseId === lease.leaseId) {
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
    ): Promise<HistoryReplayCommitted | HistoryReplayCommitRefused> {
        const operation = commit_history_replay(request, payload)
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
                replay_leases.settle(request.leaseId, result, Date.now());
                return result;
            })
            .finally(() => {
                if (active_replay_commit === operation) active_replay_commit = undefined;
            });
        active_replay_commit = operation;
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

        // The compare-and-swap. `conflict` is reported by the updater rather than
        // thrown, because a conflict is an ordinary outcome — someone typed while
        // the replay was in flight — and must leave history exactly where it is.
        let conflicted = false;
        let unavailable = false;
        const replay_committed = await update_file_state((current, updater_sheets) => {
            conflicted = false;
            unavailable = false;
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
            for (const [sheet_index, sheet_writes] of by_sheet) {
                const sheet = identities[sheet_index];
                const cells = pending_edits_for_sheet(
                    next.pendingEdits,
                    sheet_index,
                    sheet?.name,
                    sheet?.worksheetId,
                );
                const updated = pending_edits_with_replay_writes(cells, sheet_writes);
                if (updated === cells) continue;
                next = {
                    ...next,
                    pendingEdits: with_pending_edits_for_sheet(
                        next.pendingEdits,
                        sheet_index,
                        updated,
                        sheet?.name,
                        sheet?.worksheetId,
                    ),
                };
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
            return next;
        }, undefined, payload.isCurrent, {
            expectedAuthorityRevision: expected_authority,
            expectedPhysicalRevision: source_authority.physicalRevision,
        });

        if (unavailable) return refused('unavailable');
        if (conflicted) return refused('conflict');
        if (!payload.isCurrent()) return refused('document-changed');
        // Highlights the replay wrote have to be PUBLISHED, not merely committed.
        // `update_file_state` refreshes the session's state material without
        // delivering it, which is right for pending edits — the renderer holds
        // those in its own stores and applies the accepted writes itself — but a
        // highlight lives only in durable state, so without this the cells would
        // change on disk and never repaint.
        //
        // AFTER the currency check above, and never folded into the commit as a
        // `deliver` flag: delivering supersedes the acknowledged snapshot, so
        // `acknowledged_current()` — a term of `replay_is_current` — goes false
        // the moment it happens. Delivering first would make this replay's own
        // publication refuse it as `document-changed` with the highlight already
        // durably written, leaving the renderer's history unmoved and every retry
        // conflicting against the state the replay had in fact applied.
        //
        // Deliberately not the `cellHighlightsChanged` shape the highlight
        // COMMANDS publish: that message carries a request id and the gesture's
        // deltas, which are what enter a window's undo history. A replay is the
        // history moving, so re-entering it would record undo as a new gesture.
        if (highlight_patches.length > 0 && replay_committed !== undefined && !disposed) {
            // The material already held, not `replay_committed` re-installed. An
            // unrelated writer committing behind this replay installs a LATER
            // revision, and `update_state_snapshot` refuses an older one — so
            // re-installing to force the delivery would silently deliver nothing
            // and leave the replayed highlight painted stale indefinitely. That
            // newer material already contains this commit.
            session.deliver_current_material();
        }
        // The updater's own result is used ONLY for that delivery. An unchanged
        // updater reports `undefined` — for a replay that means the document
        // already held everything the replay would write, a byte-identical redo of
        // a gesture that changed nothing durable, which is a success and not a
        // refusal, and needs no repaint. The answer below is assembled from the
        // retained preparation either way.
        return Object.freeze({
            requestId: request.requestId,
            replayId: request.replayId,
            leaseId: request.leaseId,
            mutationId: request.mutationId,
            sourceGeneration: payload.sourceGeneration,
            cells: Object.freeze(writes.map((write) => Object.freeze({
                ordinal: write.ordinal,
                resolvedSheetIndex: write.sheetIndex,
                key: write.key,
                entry: write.entry,
            }))),
            focusSheetIndex: payload.focusSheetIndex,
            focus: payload.focus,
            // Resolved HERE and not at preparation: a replay waits on a keypress
            // and a round trip, and a transform queued in that window would make a
            // preparation-time answer name rows the user is no longer looking at.
            // Serialized commands mean anything queued after this point publishes
            // after the commit, and the generation stamp is what lets the renderer
            // decline a projection that was overtaken anyway.
            displayFocus: resolve_replay_display_focus(
                payload,
                (sheet_index, source_row) => replay_core.display_row_for_source(
                    sheet_index,
                    source_row,
                ),
                replay_core.mapping_generation(payload.focusSheetIndex),
            ),
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
            })) return false;
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
            const transform_tails = [...transform_commit_barriers]
                .map((barrier) => barrier.completion);
            const compare_tails = [...compare_diff_sidecars];
            await Promise.all([
                edit_tail,
                save_tail,
                disposal_release_tail,
                layout_tail,
                ...transform_tails,
                ...compare_tails,
            ]);
            if (
                edit_tail === pending_edit_writes
                && save_tail === active_save_drain
                && disposal_release_tail === disposal_edit_release_drain
                && layout_tail === layout_write_tail
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
