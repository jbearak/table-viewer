import { createHash } from 'crypto';
import * as path from 'path';
import * as vscode from 'vscode';
import { XlsxDataSource } from './data-source/xlsx-source';
import { XlsDataSource } from './data-source/xls-source';
import { CsvDataSource } from './data-source/csv-source';
import { ExcelHeaderDataSource } from './data-source/excel-header-source';
import type {
    DataSource,
    RenderedCell,
} from './data-source/interface';
import { ViewerPanelCore, adopt_source_into_core, type PanelLike } from './panel-core';
import { PanelSession, type PanelAdoption } from './panel-session';
import {
    get_csv_max_rows, get_default_orientation, get_delimiter, get_max_file_size_mib,
} from './viewer-config';
import { assert_safe_file_size, MAX_CSV_ROWS } from './spreadsheet-safety';
import { serialize_csv } from './serialize-csv';
import type {
    AuthorityFileStateStore,
    DurableFileAuthority,
    FileStateSnapshot,
} from './state';
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
    type PhysicalAuthorityCommitReceipt,
} from './file-coordinator';
import { reconcile_finalization } from './finalization-reconciliation';
import { SourceCandidate } from './source-candidate';
import {
    sanitize_excel_header_overrides,
    transform_has_entries,
    transform_schema_for_sheet,
    type PerFileState,
    type SheetTransformState,
    type WebviewMessage,
} from './types';
import {
    normalize_per_file_state,
    sanitize_transform_state,
} from './webview/sheet-state';
import { sanitize_column_visibility_state } from './webview/column-projection';

/** The host surface the controller needs: the core's `PanelLike` (postMessage)
 *  plus inbound messages. Both vscode.WebviewPanel and the unit-test mock panel
 *  satisfy it; html is set by the host before attaching. */
export interface ViewerHostPanel extends PanelLike {
    webview: PanelLike['webview'] & {
        onDidReceiveMessage(handler: (msg: WebviewMessage) => unknown): vscode.Disposable;
    };
}

export interface ViewerProfile {
    /** Fixed for one attachment; mixing metadata protocols is a controller bug. */
    metadataDelivery: 'legacy' | 'workbookSnapshot';
    /** Build a DataSource from freshly-read bytes. Throws are surfaced as errors. */
    build_source(
        raw: Uint8Array,
        file_path: string,
        state: PerFileState,
    ): Promise<DataSource>;
    /** Enables csvEditingSupported + saveCsv/pendingEdits/showSaveDialog handling. */
    editing: boolean;
    /** Sets previewMode on the meta envelope (read-only synced preview). */
    previewMode?: boolean;
    /** Called after each (re)load adopts a source — preview refreshes its line map. */
    on_source_adopted?(source: DataSource): void;
    /** Handle a message the controller does not own (preview: visibleRowChanged).
     *  Return true if handled. */
    on_message?(msg: WebviewMessage): boolean | Promise<boolean>;
}

const active_csv_edit_sessions = new Map<string, symbol>();
const HEADER_RELOAD_RETRY_COUNT = 3;
const HEADER_RELOAD_RETRY_MS = 25;
const RELOAD_RETRY_COUNT = 3;
const RELOAD_RETRY_MS = 50;
const HEADER_TERMINAL_RETRY_COUNT = 3;
const READY_STATE_RETRY_COUNT = 3;
const READY_STATE_RETRY_MS = 50;

function content_digest(bytes: Uint8Array): string {
    return createHash('sha256').update(bytes).digest('hex');
}

function delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

interface HeaderSettlement {
    requestId: string;
    error: string | undefined;
    origin: boolean;
    operationEpoch: number;
}

interface ExcelHeaderRecovery {
    requestId: string;
    settlement: HeaderSettlement;
}

interface LegacyDeliveryIdentity {
    readonly adoptionEpoch: number;
    readonly source: DataSource;
    readonly digest: string | undefined;
    readonly authorityRevision: number;
    readonly physicalRevision: number;
    readonly projectionRevision: number;
    readonly generation: number;
    readonly sourceGeneration: number;
}

interface LegacyDeliveryResult {
    readonly delivered: boolean;
    readonly identity: LegacyDeliveryIdentity;
    readonly current: boolean;
}

type PhysicalAuthorityCommitResult =
    | { type: 'committed'; receipt: PhysicalAuthorityCommitReceipt }
    | { type: 'stale' }
    | { type: 'rejected' }
    | { type: 'advanced' };

function same_snapshot_identity(
    left: NonNullable<Extract<WebviewMessage, { type: 'stateChanged' }>['snapshotIdentity']>,
    right: NonNullable<Extract<WebviewMessage, { type: 'stateChanged' }>['snapshotIdentity']>,
): boolean {
    return left.deliveryId === right.deliveryId
        && left.authority.fileId === right.authority.fileId
        && left.authority.revision === right.authority.revision
        && left.stateRevision === right.stateRevision
        && left.sourceBasis.physicalRevision === right.sourceBasis.physicalRevision
        && left.sourceBasis.projectionRevision === right.sourceBasis.projectionRevision;
}

function same_durable_authority(
    left: DurableFileAuthority,
    right: DurableFileAuthority,
): boolean {
    return left.commitSequence === right.commitSequence
        && left.authorityRevision === right.authorityRevision
        && left.physicalRevision === right.physicalRevision
        && left.projectionRevision === right.projectionRevision
        && left.physicalDigest === right.physicalDigest;
}

function excel_profile(): ViewerProfile {
    return {
        metadataDelivery: 'legacy',
        editing: false,
        async build_source(raw, file_path, state) {
            const physical = file_path.toLowerCase().endsWith('.xlsx')
                ? await XlsxDataSource.create(raw)
                : await XlsDataSource.create(Buffer.from(raw));
            return new ExcelHeaderDataSource(
                physical,
                sanitize_excel_header_overrides(state.excelFirstRowHeaders),
            );
        },
    };
}

/** Build the editable CSV/TSV DataSource shared by the table and preview hosts. */
export function build_csv_source(raw: Uint8Array, file_path: string): Promise<CsvDataSource> {
    const max_rows = Math.min(get_csv_max_rows(), MAX_CSV_ROWS);
    // CSV/TSV files conventionally carry column names in their first row, so the
    // grid promotes it to the column header rather than showing letters.
    return CsvDataSource.create(raw, get_delimiter(file_path), max_rows, {
        firstRowIsHeader: true,
    });
}

export function csv_table_profile(): ViewerProfile {
    return {
        metadataDelivery: 'workbookSnapshot',
        editing: true,
        build_source: build_csv_source,
    };
}

/** Profile for a uri, by extension: csv/tsv → editable table; else Excel viewer. */
export function profile_for(uri: vscode.Uri): ViewerProfile {
    const ext = uri.fsPath.toLowerCase();
    return ext.endsWith('.csv') || ext.endsWith('.tsv')
        ? csv_table_profile()
        : excel_profile();
}

/**
 * Wire a webview panel to a file: initial load on `ready`, live reload via a
 * directory watcher with a monotonic guard, paginated row serving (via the
 * core), and — for editing profiles — save/conflict/pending-edit handling.
 * Returns a Disposable that tears everything down. The host sets webview html
 * and options before calling this.
 */
export function attach_viewer(
    panel: ViewerHostPanel,
    uri: vscode.Uri,
    state_store: AuthorityFileStateStore,
    profile: ViewerProfile,
): vscode.Disposable {
    const file_path = uri.fsPath;
    const disposables: vscode.Disposable[] = [];
    const durable_state_store = state_store;
    const file_coordinator = acquire_file_coordinator(file_path, durable_state_store);
    const state_path = file_coordinator.statePath;
    const file_key = file_coordinator.authority().fileKey;
    const uses_snapshots = profile.metadataDelivery === 'workbookSnapshot';

    // Borrowed aliases are updated only at the same synchronous boundary as the
    // session adoption. PanelSession remains the sole source/core lifecycle owner.
    let core: ViewerPanelCore | undefined;
    let source: DataSource | undefined;
    let source_authority = file_coordinator.authority();
    const transform_authorities = new Map<string, number>();
    let reload_seq = 0;
    let disposed = false;
    let initial_meta_sent = false;
    let ready_seen = false;
    let adoption_epoch = 0;
    let adopted_digest: string | undefined;
    let delivered_identity: LegacyDeliveryIdentity | undefined;
    let reload_retry_attempts = 0;
    let reload_retry_timer: ReturnType<typeof setTimeout> | undefined;
    const terminal_retry_waits = new Set<{
        timer: ReturnType<typeof setTimeout>;
        resolve: (proceed: boolean) => void;
    }>();
    const ready_state_retry_waits = new Set<{
        timer: ReturnType<typeof setTimeout>;
        resolve: (proceed: boolean) => void;
    }>();
    let outstanding_header_settlement: HeaderSettlement | undefined;
    const edit_session_token = Symbol(file_key);
    const excel_header_subscriber_token = Symbol(file_key);
    const released_sources = new WeakSet<DataSource>();
    const released_cores = new WeakSet<ViewerPanelCore>();

    const session = new PanelSession({
        transportEnabled: uses_snapshots,
        postMessage: (message) => {
            if (!uses_snapshots) {
                throw new Error('Legacy panels cannot emit workbookSnapshot metadata.');
            }
            return panel.webview.postMessage(message);
        },
        onNeedsResyncSource: () => { void send_reload(true); },
        onCurrentAdoptionAcknowledged: (adoption) => {
            if (!uses_snapshots || disposed || session.current_adoption() !== adoption) return;
            const digest = adoption.source === 'commitReceipt'
                ? adoption.receipt.resultingBasis.physicalDigest
                : adoption.authority.physicalDigest;
            for (const [index, warning] of (adoption.warnings ?? []).entries()) {
                const basis = digest
                    ?? (adoption.source === 'commitReceipt'
                        ? adoption.receipt.resultingBasis.physicalRevision
                        : adoption.authority.physicalRevision);
                if (file_coordinator.mark_warning_seen(`${basis}:${index}:${warning}`)) {
                    void vscode.window.showWarningMessage(warning);
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

    function owns_edit_session(): boolean {
        return active_csv_edit_sessions.get(file_key) === edit_session_token;
    }

    function try_claim_edit_session(): boolean {
        const owner = active_csv_edit_sessions.get(file_key);
        if (owner && owner !== edit_session_token) return false;
        active_csv_edit_sessions.set(file_key, edit_session_token);
        return true;
    }

    function release_edit_session(): void {
        if (owns_edit_session()) active_csv_edit_sessions.delete(file_key);
    }

    /** Project durable state for this panel without mutating shared authority. */
    function project_state_for_panel(
        snapshot: Readonly<FileStateSnapshot>,
        allow_claim = false,
    ): FileStateSnapshot {
        const state = snapshot.state as PerFileState;
        if (!state.pendingEdits) {
            return { revision: snapshot.revision, state };
        }
        if (
            profile.editing
            && (owns_edit_session() || (allow_claim && try_claim_edit_session()))
        ) {
            return { revision: snapshot.revision, state };
        }
        const { pendingEdits: _drop, ...rest } = state;
        return { revision: snapshot.revision, state: rest };
    }

    function update_session_state_material(
        snapshot: Readonly<FileStateSnapshot>,
        allow_claim = false,
    ): void {
        if (!uses_snapshots) return;
        session.update_state_snapshot(project_state_for_panel(snapshot, allow_claim));
    }

    async function refresh_session_state_material(
        allow_claim = false,
    ): Promise<FileStateSnapshot> {
        const snapshot = await read_file_state();
        update_session_state_material(snapshot, allow_claim);
        return snapshot;
    }

    // CSV editability flags for the meta/reload envelope. Non-editing profiles
    // emit `undefined` (not `false`) deliberately: on the reload path the webview
    // only applies these when they are defined, so `undefined` leaves the prior
    // state untouched. Do not collapse to plain booleans.
    function editing_flags(ds: DataSource): { csvEditingSupported: true | undefined; csvEditable: boolean | undefined } {
        return profile.editing
            ? { csvEditingSupported: true, csvEditable: !ds.truncationMessage }
            : { csvEditingSupported: undefined, csvEditable: undefined };
    }

    async function read_file_state(touch = true): Promise<FileStateSnapshot> {
        await file_coordinator.state_ready();
        const snapshot = await state_store.read(state_path);
        if (touch) await state_store.touch(state_path);
        return snapshot;
    }

    async function update_file_state(
        updater: (current: PerFileState) => PerFileState,
        sheet_names = source?.meta().sheets.map((sheet) => sheet.name) ?? [],
        validate?: () => boolean,
    ): Promise<FileStateSnapshot | undefined> {
        let snapshot = await read_file_state();
        for (;;) {
            const current = normalize_host_state(snapshot.state, sheet_names);
            const next = updater(current);
            if (next === current) return undefined;
            const result = await state_store.compare_and_set(
                state_path,
                snapshot.revision,
                next,
                validate,
            );
            if (result.type === 'committed') {
                update_session_state_material(result.snapshot);
                return result.snapshot;
            }
            snapshot = result.snapshot;
        }
    }

    async function persist_transform_commit(
        message: Extract<WebviewMessage, { type: 'setTransform' }>,
        state: SheetTransformState,
    ): Promise<void> {
        // Restores merely recompute host-owned preferences. Only explicit user
        // actions can replace those preferences, and the core awaits this write
        // before posting its terminal acknowledgement.
        if (message.intent === 'restore') return;
        const expected_authority = transform_authorities.get(message.requestId);
        if (expected_authority === undefined) return;
        const committed = await update_file_state((current) => {
            const sheet = source?.meta().sheets[message.sheetIndex];
                if (
                    disposed
                    || !core
                    || !file_coordinator.state_write_is_current(expected_authority)
                    || source_authority.authorityRevision !== expected_authority
                    || message.sourceGeneration !== core.source_generation
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
                        filters: state.filters.map((entry) => ({ ...entry })),
                    }
                    : undefined;
            return { ...current, transforms };
        }, undefined, () => (
            !disposed
            && file_coordinator.state_write_is_current(expected_authority)
            && source_authority.authorityRevision === expected_authority
            && message.sourceGeneration === core?.source_generation
        ));
        if (!committed) {
            throw new Error('The source changed before this sort/filter could be saved.');
        }
    }

    async function build_source(): Promise<SourceCandidate> {
        const state = (await read_file_state()).state as PerFileState;
        const stat = await vscode.workspace.fs.stat(uri);
        const max_mib = get_max_file_size_mib();
        assert_safe_file_size(stat.size, max_mib);
        const raw = await vscode.workspace.fs.readFile(uri);
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
    ): Promise<boolean> {
        if (disposed || seq !== reload_seq) return false;
        const { fingerprint, digest } = candidate.observation;
        const stat = await vscode.workspace.fs.stat(uri);
        if (
            disposed
            || seq !== reload_seq
            || `${stat.mtime}:${stat.size}` !== fingerprint
        ) {
            return false;
        }
        const raw = await vscode.workspace.fs.readFile(uri);
        const verified_stat = await vscode.workspace.fs.stat(uri);
        return !disposed
            && seq === reload_seq
            && `${verified_stat.mtime}:${verified_stat.size}` === fingerprint
            && content_digest(raw) === digest;
    }

    async function commit_physical_candidate(
        candidate: SourceCandidate,
        seq: number,
        expected_authority_revision: number,
        already_verified = false,
    ): Promise<PhysicalAuthorityCommitResult> {
        if (
            !already_verified
            && !await built_source_is_current(seq, candidate)
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
        const sheet_names = planning_input?.sheets.map((sheet) => sheet.name) ?? [];
        try {
            for (;;) {
                if (
                    disposed
                    || seq !== reload_seq
                    || !file_coordinator.operation_is_current(token)
                ) return { type: 'stale' };
                const state_snapshot = await read_file_state(false);
                const plan = planning_input
                    ? plan_excel_candidate_state(
                        normalize_host_state(state_snapshot.state, sheet_names),
                        planning_input,
                    )
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
                        nextState: plan?.changed ? plan.state : undefined,
                        physicalDigest: digest,
                    },
                );
                if (staged.type === 'conflict') {
                    const current_authority = file_coordinator.authority();
                    if (same_durable_authority(staged.authority, current_authority)) {
                        continue;
                    }
                    const observation_turn = await file_coordinator.request_commit_turn(token);
                    if (observation_turn.type === 'granted') {
                        if (same_durable_authority(
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
                const requested = await file_coordinator.request_commit_turn(token);
                if (requested.type === 'rejected') return { type: 'rejected' };
                const finalizationBasis = file_coordinator.authority();
                const descriptor = {
                    transactionId: token.id,
                    kind: 'physical' as const,
                    basis: finalizationBasis,
                    expectedStateRevision: state_snapshot.revision,
                    previousState: state_snapshot.state,
                    nextState: plan?.changed ? plan.state : undefined,
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
                            ),
                        };
                    }
                    if (reconciled.type === 'advanced') {
                        file_coordinator.observe_advanced_authority(
                            token,
                            requested.turn,
                            reconciled.authority,
                        );
                        return { type: 'advanced' };
                    }
                    file_coordinator.release_commit_turn(requested.turn);
                    void discard_authority(durable_state_store, state_path, token.id);
                    throw error;
                }
                if (finalized.type === 'conflict') {
                    if (!same_durable_authority(
                        finalized.authority,
                        finalizationBasis,
                    )) {
                        file_coordinator.observe_advanced_authority(
                            token,
                            requested.turn,
                            finalized.authority,
                        );
                        return { type: 'advanced' };
                    }
                    file_coordinator.release_commit_turn(requested.turn);
                    continue;
                }
                return {
                    type: 'committed',
                    receipt: file_coordinator.finalize_authority_commit(
                        token,
                        requested.turn,
                        finalized,
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
    ): DataSource | undefined {
        // A durable commit can finish after a newer panel-local load starts. Keep
        // ownership with the candidate unless this exact load is still current at
        // the synchronous installation boundary.
        if (disposed || seq !== reload_seq) return undefined;
        const inspected = candidate.borrow();
        if (inspected instanceof ExcelHeaderDataSource) {
            const committed_state = normalize_host_state(
                committed.receipt.stateSnapshot.state,
                inspected.meta().sheets.map((sheet) => sheet.name),
            );
            inspected.replace_overrides(sanitize_excel_header_overrides(
                committed_state.excelFirstRowHeaders,
            ));
        }
        let adopted: DataSource | undefined;
        const transferred = candidate.transfer_to((next, confirm_transfer) => {
            if (disposed || seq !== reload_seq) return;
            const result = adopt_source_into_core(
                core,
                panel,
                undefined,
                next,
                { onTransformCommit: persist_transform_commit },
                (installed) => {
                    const material = installed.snapshot_material();
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
                                defaultTabOrientation: get_default_orientation(),
                                previewMode: profile.previewMode === true,
                            },
                            capabilities: {
                                csvEditingSupported: profile.editing,
                                csvEditable: profile.editing && !next.truncationMessage,
                            },
                            stateSnapshot: adoption_state,
                        }),
                    };
                    core = installed;
                    source = next;
                    source_authority = committed.receipt.resultingBasis;
                    adopted_digest = committed.receipt.digest;
                    adoption_epoch += 1;
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

    function capture_legacy_delivery_identity(
        expected_source: DataSource,
    ): LegacyDeliveryIdentity | undefined {
        if (disposed || !core || source !== expected_source) return undefined;
        return Object.freeze({
            adoptionEpoch: adoption_epoch,
            source: expected_source,
            digest: adopted_digest,
            authorityRevision: source_authority.authorityRevision,
            physicalRevision: source_authority.physicalRevision,
            projectionRevision: source_authority.projectionRevision,
            generation: core.generation,
            sourceGeneration: core.source_generation,
        });
    }

    function legacy_delivery_is_current(
        identity: LegacyDeliveryIdentity,
    ): boolean {
        return !disposed
            && core !== undefined
            && source === identity.source
            && adoption_epoch === identity.adoptionEpoch
            && adopted_digest === identity.digest
            && source_authority.authorityRevision === identity.authorityRevision
            && source_authority.physicalRevision === identity.physicalRevision
            && source_authority.projectionRevision === identity.projectionRevision
            && core.generation === identity.generation
            && core.source_generation === identity.sourceGeneration;
    }

    function metadata_is_delivered(): boolean {
        return initial_meta_sent
            && delivered_identity !== undefined
            && legacy_delivery_is_current(delivered_identity)
            && source_authority.authorityRevision
                === file_coordinator.authority().authorityRevision;
    }

    function mark_metadata_delivered(
        identity: LegacyDeliveryIdentity,
        seq?: number,
    ): boolean {
        if (!legacy_delivery_is_current(identity)) return false;
        delivered_identity = identity;
        // A direct header projection delivery is not completion of an unrelated
        // physical-file reload episode. Only that episode's own successful post
        // may clear its retry timer and budget.
        if (seq !== undefined && seq === reload_seq) reset_reload_retry();
        return true;
    }

    async function state_for_reload(ds: DataSource): Promise<PerFileState> {
        return normalize_per_file_state(
            (await read_file_state()).state,
            ds.meta().sheets.map((sheet) => sheet.name),
        );
    }

    async function state_for_first_meta(
        committed_state?: PerFileState,
    ): Promise<PerFileState> {
        const state = committed_state
            ?? (await read_file_state()).state as PerFileState;
        if (!profile.editing || !state.pendingEdits) return state;
        if (try_claim_edit_session()) return state;
        const { pendingEdits: _drop, ...rest } = state;
        return rest;
    }

    function state_from_physical_receipt(
        ds: DataSource,
        receipt: PhysicalAuthorityCommitReceipt,
    ): PerFileState {
        return normalize_per_file_state(
            receipt.stateSnapshot.state,
            ds.meta().sheets.map((sheet) => sheet.name),
        );
    }

    async function send_first_meta(
        ds: DataSource,
        committed_state?: PerFileState,
    ): Promise<LegacyDeliveryResult | undefined> {
        if (uses_snapshots) {
            throw new Error('Snapshot panels cannot emit legacy metadata.');
        }
        const state = await state_for_first_meta(committed_state);
        const identity = capture_legacy_delivery_identity(ds);
        if (!identity || !core) return undefined;
        const settlement = outstanding_header_settlement;
        const delivered = await core.send_meta({
            state,
            defaultTabOrientation: get_default_orientation(),
            previewMode: profile.previewMode,
            ...editing_flags(ds),
            projectionChange: settlement ? 'excelHeader' : undefined,
            headerRequestId: settlement?.requestId,
            error: settlement?.error,
        });
        const current = legacy_delivery_is_current(identity);
        if (
            delivered
            && current
            && ready_seen
            && settlement === outstanding_header_settlement
        ) {
            initial_meta_sent = true;
            outstanding_header_settlement = undefined;
        }
        return { delivered, identity, current };
    }

    async function post_reload(
        ds: DataSource,
        projectionChange?: 'excelHeader',
        headerRequestId?: string,
        state?: PerFileState,
    ): Promise<LegacyDeliveryResult | undefined> {
        if (uses_snapshots) {
            throw new Error('Snapshot panels cannot emit legacy metadata.');
        }
        const resolved_state = state ?? (outstanding_header_settlement
            ? await state_for_reload(ds)
            : undefined);
        const identity = capture_legacy_delivery_identity(ds);
        if (!identity || !core) return undefined;
        const settlement = outstanding_header_settlement;
        const delivered = await core.send_meta_reload({
            ...editing_flags(ds),
            projectionChange: settlement ? 'excelHeader' : projectionChange,
            headerRequestId: settlement?.requestId ?? headerRequestId,
            state: settlement ? resolved_state : state,
        });
        const current = legacy_delivery_is_current(identity);
        if (
            delivered
            && current
            && settlement === outstanding_header_settlement
        ) {
            outstanding_header_settlement = undefined;
        }
        return { delivered, identity, current };
    }

    async function post_meta_recovery(
        ds: DataSource,
        settlement: HeaderSettlement,
    ): Promise<LegacyDeliveryResult | undefined> {
        if (uses_snapshots) {
            throw new Error('Snapshot panels cannot emit legacy metadata.');
        }
        const state = await state_for_reload(ds);
        const identity = capture_legacy_delivery_identity(ds);
        if (!identity || !core) return undefined;
        const delivered = await core.send_meta_recovery({
            state,
            ...editing_flags(ds),
            headerRequestId: settlement.requestId,
            error: settlement.error,
        });
        return {
            delivered,
            identity,
            current: legacy_delivery_is_current(identity),
        };
    }

    async function post_header_projection(
        ds: DataSource,
        request_id: string,
        committed_state?: PerFileState,
    ): Promise<LegacyDeliveryResult | undefined> {
        if (!initial_meta_sent) return send_first_meta(ds, committed_state);
        const state = committed_state ?? await state_for_reload(ds);
        return post_reload(ds, 'excelHeader', request_id, state);
    }

    async function apply_excel_header_receipt(
        receipt: ExcelHeaderOperationReceipt,
    ): Promise<void> {
        if (disposed) return;
        const is_origin = receipt.originToken === excel_header_subscriber_token;
        const settlement = publish_header_settlement(
            receipt.requestId,
            receipt.resultingBasis.authorityRevision,
            is_origin,
        );
        if (
            source_authority.authorityRevision
                !== receipt.previousBasis.authorityRevision
            || source_authority.physicalRevision
                !== receipt.previousBasis.physicalRevision
        ) {
            void send_header_recovery(
                settlement,
                is_origin
                    ? 'The header setting was saved, but the view could not refresh.'
                    : undefined,
            );
            return;
        }
        if (
            !core
            || !(source instanceof ExcelHeaderDataSource)
            || !source.set_override(receipt.sheetName, receipt.override)
        ) {
            void send_header_recovery(
                settlement,
                is_origin
                    ? 'The header setting was saved, but the view could not refresh.'
                    : undefined,
            );
            return;
        }
        // The projected source object is intentionally reused, but its logical
        // adoption still advances both generations and invalidates source work.
        const projection_adoption = adopt_source_into_core(
            core,
            panel,
            source,
            source,
        );
        if (projection_adoption.type === 'refused') {
            void send_header_recovery(
                settlement,
                is_origin
                    ? 'The header setting was saved, but the view could not refresh.'
                    : undefined,
            );
            return;
        }
        core = projection_adoption.core;
        source_authority = receipt.resultingBasis;
        adoption_epoch += 1;
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
                    defaultTabOrientation: get_default_orientation(),
                    previewMode: false,
                },
                capabilities: {
                    csvEditingSupported: false,
                    csvEditable: false,
                },
            }),
        });
        const attempts = is_origin ? HEADER_RELOAD_RETRY_COUNT : 1;
        for (let attempt = 0; attempt < attempts; attempt++) {
            if (
                disposed
                || source_authority.authorityRevision
                    !== receipt.resultingBasis.authorityRevision
            ) return;
            try {
                const delivery = await post_header_projection(
                    source,
                    receipt.requestId,
                    receipt.stateSnapshot.state as PerFileState,
                );
                if (
                    delivery?.delivered
                    && delivery.current
                    && mark_metadata_delivered(delivery.identity)
                ) return;
            } catch {
                // Delivery and retry remain panel-local and never hold the file queue.
            }
            if (attempt + 1 < attempts) await delay(HEADER_RELOAD_RETRY_MS);
        }
        if (!disposed) {
            void send_header_recovery(
                settlement,
                is_origin
                    ? 'The header setting was saved, but the view could not refresh.'
                    : undefined,
            );
        }
    }

    disposables.push(file_coordinator.subscribe_excel_headers(
        apply_excel_header_receipt,
    ));

    function surface_warnings(ds: DataSource): void {
        const warnings = ds.warnings ?? [];
        if (warnings.length > 0) vscode.window.showWarningMessage(warnings[0]);
    }

    // CSV pending-edit persistence deliberately remains on FileStateStore's CAS
    // queue in this phase. Edit-session ownership is separate from file authority;
    // physical/projection/layout writes use the coordinator serialization above.
    async function clear_pending_edits(): Promise<void> {
        const committed = await update_file_state((current) => {
            if (!current.pendingEdits) return current;
            const { pendingEdits: _drop, ...rest } = current;
            return rest;
        });
        if (!committed && uses_snapshots) await refresh_session_state_material();
    }

    async function send_initial_data(): Promise<void> {
        reset_reload_retry();
        const seq = ++reload_seq;
        let candidate: SourceCandidate | undefined;
        try {
            const expected_authority = file_coordinator.authority().authorityRevision;
            candidate = await build_source();
            const committed = await commit_physical_candidate(
                candidate, seq, expected_authority,
            );
            if (committed.type !== 'committed') {
                schedule_reload_retry(true, seq);
                return;
            }
            const receipt_state = state_from_physical_receipt(
                candidate.borrow(), committed.receipt,
            );
            const initial_state = uses_snapshots
                ? undefined
                : await state_for_first_meta(receipt_state);
            const projected_state = uses_snapshots
                ? await read_file_state()
                : {
                    revision: committed.receipt.stateSnapshot.revision,
                    state: initial_state!,
                } satisfies FileStateSnapshot;
            const ds = adopt_committed_candidate(
                candidate, committed, seq, 'ready', projected_state,
            );
            if (!ds) return;
            if (uses_snapshots) {
                reset_reload_retry();
                return;
            }
            const delivery = await send_first_meta(ds, initial_state);
            if (
                delivery?.delivered
                && delivery.current
                && mark_metadata_delivered(delivery.identity, seq)
            ) {
                surface_warnings(ds);
            } else {
                schedule_reload_retry(true, seq);
            }
        } catch (err) {
            if (disposed) return;
            if (!schedule_reload_retry(true, seq)) {
                vscode.window.showErrorMessage(err instanceof Error ? err.message : String(err));
            }
        } finally {
            candidate?.dispose();
        }
    }

    // Build explicit refreshes before superseding watcher work. A transient
    // post-save read/parse failure therefore cannot invalidate the only viable
    // watcher refresh. The pre-adoption failures and later unstable-snapshot
    // failures share one bounded retry budget.
    async function reparse_and_post(
        reason: 'fileReload' | 'save' = 'fileReload',
    ): Promise<boolean> {
        const expected_authority = file_coordinator.authority().authorityRevision;
        let candidate: SourceCandidate | undefined;
        let attempts = 0;
        try {
            for (;;) {
                if (disposed) return false;
                try {
                    candidate = await build_source();
                    break;
                } catch (error) {
                    if (disposed || attempts >= RELOAD_RETRY_COUNT) throw error;
                    attempts += 1;
                    await delay(RELOAD_RETRY_MS);
                }
            }
            if (disposed) return false;
            reset_reload_retry();
            reload_retry_attempts = attempts;
            const seq = ++reload_seq;
            const committed = await commit_physical_candidate(
                candidate, seq, expected_authority,
            );
            if (committed.type !== 'committed') {
                schedule_reload_retry(true, seq);
                return false;
            }
            const ds = adopt_committed_candidate(
                candidate,
                committed,
                seq,
                reason,
                uses_snapshots ? await read_file_state() : undefined,
            );
            if (!ds) return false;
            if (uses_snapshots) return true;
            let delivery: LegacyDeliveryResult | undefined;
            try {
                delivery = await post_reload(
                    ds,
                    undefined,
                    undefined,
                    state_from_physical_receipt(ds, committed.receipt),
                );
            } catch (error) {
                if (!schedule_reload_retry(true, seq)) throw error;
                return false;
            }
            const delivered = !!delivery?.delivered
                && delivery.current
                && mark_metadata_delivered(delivery.identity, seq);
            if (!delivered) schedule_reload_retry(true, seq);
            return delivered;
        } finally {
            candidate?.dispose();
        }
    }

    function reset_reload_retry(): void {
        reload_retry_attempts = 0;
        if (reload_retry_timer !== undefined) {
            clearTimeout(reload_retry_timer);
            reload_retry_timer = undefined;
        }
    }

    function schedule_reload_retry(
        force: boolean,
        seq: number,
        header_recovery?: ExcelHeaderRecovery,
    ): boolean {
        if (
            disposed
            || seq !== reload_seq
            || reload_retry_attempts >= RELOAD_RETRY_COUNT
        ) {
            return false;
        }
        reload_retry_attempts += 1;
        if (reload_retry_timer !== undefined) clearTimeout(reload_retry_timer);
        reload_retry_timer = setTimeout(() => {
            reload_retry_timer = undefined;
            if (!disposed && seq === reload_seq) {
                void send_reload(force, true, header_recovery, seq);
            }
        }, RELOAD_RETRY_MS);
        return true;
    }

    async function send_reload(
        force = false,
        retry = false,
        header_recovery?: ExcelHeaderRecovery,
        retry_seq?: number,
    ): Promise<boolean> {
        if (disposed) return false;
        let seq: number;
        if (retry) {
            if (retry_seq === undefined || retry_seq !== reload_seq) return false;
            seq = retry_seq;
        } else {
            reset_reload_retry();
            seq = ++reload_seq;
        }
        let delivered = false;
        let candidate: SourceCandidate | undefined;
        try {
            const expected_authority = file_coordinator.authority().authorityRevision;
            candidate = await build_source();
            const ds = candidate.borrow();
            if (
                header_recovery
                && outstanding_header_settlement !== header_recovery.settlement
            ) {
                delivered = true;
                return delivered;
            }
            if (!await built_source_is_current(seq, candidate)) {
                if (!header_recovery) schedule_reload_retry(force, seq);
                return delivered;
            }
            // Deduplicate only when the webview has actually received metadata
            // for the currently adopted source and both core generations.
            if (
                !force
                && outstanding_header_settlement === undefined
                && (
                    uses_snapshots
                        ? candidate.observation.digest
                            === session.acknowledged_physical_digest()
                        : candidate.observation.digest === delivered_identity?.digest
                            && metadata_is_delivered()
                )
            ) {
                const deduplicated = await commit_physical_candidate(
                    candidate, seq, expected_authority, true,
                );
                if (deduplicated.type === 'committed') {
                    if (seq === reload_seq) reset_reload_retry();
                    return true;
                }
                if (!header_recovery) schedule_reload_retry(force, seq);
                return delivered;
            }
            const committed = await commit_physical_candidate(
                candidate, seq, expected_authority, true,
            );
            if (committed.type !== 'committed') {
                if (!header_recovery) schedule_reload_retry(force, seq);
                return delivered;
            }
            if (!adopt_committed_candidate(
                candidate,
                committed,
                seq,
                header_recovery ? 'recovery' : 'fileReload',
                uses_snapshots ? await read_file_state() : undefined,
            )) return false;
            if (uses_snapshots) {
                reset_reload_retry();
                return true;
            }
            if (!initial_meta_sent) {
                const delivery = await send_first_meta(
                    ds,
                    state_from_physical_receipt(ds, committed.receipt),
                );
                delivered = !!delivery?.delivered
                    && delivery.current
                    && mark_metadata_delivered(
                        delivery.identity,
                        header_recovery ? undefined : seq,
                    );
                if (!delivered) {
                    if (!header_recovery) schedule_reload_retry(force, seq);
                    return false;
                }
                surface_warnings(ds);
                return true;
            }
            const delivery = await post_reload(
                ds,
                header_recovery ? 'excelHeader' : undefined,
                header_recovery?.requestId,
                state_from_physical_receipt(ds, committed.receipt),
            );
            delivered = !!delivery?.delivered
                && delivery.current
                && mark_metadata_delivered(
                    delivery.identity,
                    header_recovery ? undefined : seq,
                );
            if (!delivered) {
                if (!header_recovery) schedule_reload_retry(force, seq);
                return false;
            }
            surface_warnings(ds);
        } catch (err) {
            if (disposed || header_recovery) return false;
            if (schedule_reload_retry(force, seq)) return false;
            console.error('Failed to reload table viewer data', err);
            vscode.window.showErrorMessage(
                `Failed to reload: ${err instanceof Error ? err.message : String(err)}`);
        } finally {
            candidate?.dispose();
        }
        return delivered;
    }

    function wait_for_terminal_retry(ms: number): Promise<boolean> {
        if (disposed) return Promise.resolve(false);
        return new Promise((resolve) => {
            const wait = {
                timer: undefined as unknown as ReturnType<typeof setTimeout>,
                resolve,
            };
            wait.timer = setTimeout(() => {
                terminal_retry_waits.delete(wait);
                resolve(true);
            }, ms);
            terminal_retry_waits.add(wait);
        });
    }

    function cancel_terminal_retry_waits(): void {
        for (const wait of [...terminal_retry_waits]) {
            clearTimeout(wait.timer);
            terminal_retry_waits.delete(wait);
            wait.resolve(false);
        }
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
                    console.error(
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

    function publish_header_settlement(
        request_id: string,
        operation_epoch: number,
        origin: boolean,
        terminal_error?: string,
    ): HeaderSettlement {
        if (outstanding_header_settlement?.requestId === request_id) {
            if (terminal_error !== undefined) {
                outstanding_header_settlement.error = terminal_error;
                outstanding_header_settlement.origin = true;
            }
            return outstanding_header_settlement;
        }
        const candidate: HeaderSettlement = {
            requestId: request_id,
            error: terminal_error,
            origin,
            operationEpoch: operation_epoch,
        };
        if (
            outstanding_header_settlement === undefined
            || candidate.operationEpoch > outstanding_header_settlement.operationEpoch
            || (
                candidate.operationEpoch === outstanding_header_settlement.operationEpoch
                && candidate.origin
                && !outstanding_header_settlement.origin
            )
        ) {
            outstanding_header_settlement = candidate;
        }
        return outstanding_header_settlement;
    }

    async function send_terminal_header_sync(
        tracked_settlement: HeaderSettlement,
    ): Promise<boolean> {
        if (outstanding_header_settlement !== tracked_settlement) return true;
        for (
            let attempt = 0;
            attempt <= HEADER_TERMINAL_RETRY_COUNT;
            attempt++
        ) {
            if (disposed) return false;
            if (outstanding_header_settlement !== tracked_settlement) return true;
            let delivery: LegacyDeliveryResult | undefined;
            if (outstanding_header_settlement !== tracked_settlement) return true;
            if (
                disposed
                || !core
                || !source
                || source_authority.authorityRevision
                    !== file_coordinator.authority().authorityRevision
            ) return false;
            const delivery_source = source;
            try {
                delivery = !initial_meta_sent
                    ? await send_first_meta(delivery_source)
                    : await post_meta_recovery(delivery_source, tracked_settlement);
            } catch {
                delivery = undefined;
            }
            const delivered = !!delivery?.delivered
                && delivery.current
                && mark_metadata_delivered(delivery.identity);
            if (delivered) {
                surface_warnings(delivery_source);
                if (
                    initial_meta_sent
                    && tracked_settlement === outstanding_header_settlement
                ) {
                    outstanding_header_settlement = undefined;
                }
                return true;
            }
            if (attempt === HEADER_TERMINAL_RETRY_COUNT) break;
            const proceed = await wait_for_terminal_retry(
                RELOAD_RETRY_MS * (2 ** attempt),
            );
            if (!proceed) return false;
            if (outstanding_header_settlement !== tracked_settlement) return true;
        }
        return false;
    }

    async function send_header_recovery(
        tracked_settlement: HeaderSettlement,
        terminal_error?: string,
    ): Promise<boolean> {
        if (outstanding_header_settlement !== tracked_settlement) return true;
        if (terminal_error !== undefined) {
            tracked_settlement.error = terminal_error;
            tracked_settlement.origin = true;
        }
        const seq = reload_seq;
        const recovery = {
            requestId: tracked_settlement.requestId,
            settlement: tracked_settlement,
        };
        for (let attempt = 0; attempt <= RELOAD_RETRY_COUNT; attempt++) {
            if (disposed) return false;
            if (outstanding_header_settlement !== tracked_settlement) return true;
            if (seq !== reload_seq) {
                return send_terminal_header_sync(tracked_settlement);
            }
            if (attempt > 0) {
                await delay(RELOAD_RETRY_MS);
                if (disposed) return false;
                if (outstanding_header_settlement !== tracked_settlement) return true;
                if (seq !== reload_seq) {
                    return send_terminal_header_sync(tracked_settlement);
                }
            }
            if (await send_reload(true, true, recovery, seq)) return true;
        }
        return send_terminal_header_sync(tracked_settlement);
    }

    async function handle_save(edits: Record<string, string>): Promise<void> {
        if (!source) return;
        if (source.truncationMessage) {
            panel.webview.postMessage({ type: 'saveResult', success: false });
            return;
        }
        try {
            const current_adoption = session.current_adoption();
            const expected_digest = uses_snapshots
                ? session.acknowledged_physical_digest()
                : adopted_digest;
            if (
                expected_digest === undefined
                || (uses_snapshots
                    ? !session.acknowledged_current()
                        || current_adoption?.resources.source !== source
                        || current_adoption.resources.core !== core
                        || source_authority.authorityRevision
                            !== file_coordinator.authority().authorityRevision
                    : !metadata_is_delivered())
            ) {
                vscode.window.showWarningMessage(
                    'The table view is still refreshing. Please try saving again.');
                panel.webview.postMessage({ type: 'saveResult', success: false });
                return;
            }
            const SAVE_WINDOW = 10_000;
            const src = source;
            const row_count = src.meta().sheets[0].rowCount;
            function* row_windows(): Generator<(RenderedCell | null)[]> {
                for (let start = 0; start < row_count; start += SAVE_WINDOW) {
                    const { rows } = src.read_rows(0, start, SAVE_WINDOW);
                    for (const row of rows) yield row;
                }
            }
            // serialize_csv re-prepends src.headerLine (when the source consumed
            // row 0 as the column names) so the header survives the save even
            // though it is never an editable grid cell.
            const content = serialize_csv(
                row_windows(), get_delimiter(file_path), edits,
                src.originalColumnCounts, src.lineEnding, src.headerLine);
            const current_stat = await vscode.workspace.fs.stat(uri);
            const max_mib = get_max_file_size_mib();
            assert_safe_file_size(current_stat.size, max_mib);
            const current_raw = await vscode.workspace.fs.readFile(uri);
            assert_safe_file_size(current_raw.byteLength, max_mib);
            const verified_stat = await vscode.workspace.fs.stat(uri);
            const snapshot_changed = current_stat.mtime !== verified_stat.mtime
                || current_stat.size !== verified_stat.size;
            if (
                snapshot_changed
                || content_digest(current_raw) !== expected_digest
                || (uses_snapshots && (
                    !session.acknowledged_current()
                    || session.current_adoption() !== current_adoption
                    || current_adoption?.resources.source !== src
                    || current_adoption.resources.core !== core
                    || source_authority.authorityRevision
                        !== file_coordinator.authority().authorityRevision
                ))
            ) {
                vscode.window.showWarningMessage(
                    'File was modified externally. Please review the changes and try again.');
                try {
                    await reparse_and_post();
                } catch (reload_err) {
                    console.error('Post-conflict reload failed', reload_err);
                }
                panel.webview.postMessage({ type: 'saveResult', success: false });
                return;
            }
            await vscode.workspace.fs.writeFile(uri, new TextEncoder().encode(content));
            // Clear edit state before creating the post-save adoption so neither a
            // replayed delivery nor a new ready epoch can restore saved edits.
            await clear_pending_edits();
            // The write succeeded — the save is done. A failure to re-parse the
            // just-written file (a transient read error, or an external delete in
            // the TOCTOU window) must not be reported as a failed save: the bytes
            // are on disk. The adopted digest changes only after a successful reparse, so
            // the watcher event from our own write still refreshes the grid here.
            try {
                await reparse_and_post('save');
            } catch (reload_err) {
                console.error('Post-save reload failed (file was written)', reload_err);
            }
            panel.webview.postMessage({ type: 'saveResult', success: true });
        } catch (err) {
            vscode.window.showErrorMessage(
                `Failed to save: ${err instanceof Error ? err.message : String(err)}`);
            panel.webview.postMessage({ type: 'saveResult', success: false });
        }
    }

    disposables.push(panel.webview.onDidReceiveMessage(async (msg: WebviewMessage) => {
        if (disposed) return;
        if (
            uses_snapshots
            && msg.type !== 'ready'
            && msg.type !== 'snapshotApplied'
            && msg.type !== 'showWarning'
        ) {
            session.wake_delivery();
        }
        switch (msg.type) {
            case 'ready': {
                ready_seen = true;
                if (!uses_snapshots) {
                    const ready = session.ready();
                    if (ready.type === 'needsInitialSource') await send_initial_data();
                    return;
                }
                const begun = session.begin_ready();
                if (begun.hasSource) {
                    const state_snapshot = await read_state_for_ready_epoch(
                        begun.receiverEpoch,
                    );
                    if (
                        disposed
                        || !session.ready_epoch_is_current(begun.receiverEpoch)
                    ) return;
                    if (state_snapshot) {
                        update_session_state_material(state_snapshot, true);
                    }
                }
                const ready = session.complete_ready(begun.receiverEpoch);
                if (ready.type === 'needsInitialSource') await send_initial_data();
                return;
            }
            case 'snapshotApplied':
                if (uses_snapshots) {
                    session.handle_snapshot_applied(msg.identity, msg.disposition);
                }
                return;
            case 'stateChanged': {
                const expected_authority = source_authority.authorityRevision;
                const acknowledged_identity = uses_snapshots
                    ? session.acknowledged_identity()
                    : undefined;
                const native_identity_is_current = !uses_snapshots || (
                    msg.snapshotIdentity !== undefined
                    && acknowledged_identity !== undefined
                    && same_snapshot_identity(msg.snapshotIdentity, acknowledged_identity)
                );
                if (!native_identity_is_current) return;
                await update_file_state((current) => {
                        if (
                            disposed
                            || !core
                            || !file_coordinator.state_write_is_current(expected_authority)
                            || source_authority.authorityRevision !== expected_authority
                            || msg.sourceGeneration !== core.source_generation
                            || (uses_snapshots && (
                                msg.snapshotIdentity === undefined
                                || session.acknowledged_identity() === undefined
                                || !same_snapshot_identity(
                                    msg.snapshotIdentity,
                                    session.acknowledged_identity()!,
                                )
                            ))
                        ) {
                            return current;
                        }
                        const next = { ...msg.state };
                    // Transform preferences are host-owned. A delayed debounced
                    // snapshot must never resurrect a durable Cancel tombstone.
                    // Re-sanitize the host-owned value, though, so the webview's
                    // intentional cleanup after a schema change is durable.
                    const current_transforms = current.transforms;
                    next.transforms = source
                        ? source.meta().sheets.map((sheet, index) =>
                            sanitize_transform_state(
                                current_transforms?.[index],
                                sheet.columnCount,
                                transform_schema_for_sheet(sheet),
                            ))
                        : current_transforms;
                    const current_visibility = current.columnVisibility;
                    next.columnVisibility = source
                        ? source.meta().sheets.map((sheet, index) =>
                            sanitize_column_visibility_state(
                                current_visibility?.[index],
                                sheet.columnCount,
                                transform_schema_for_sheet(sheet),
                            ))
                        : current_visibility;
                    // Pending edits are host-owned for every profile. Only the
                    // edit-session owner path may change them; previews/nonowners
                    // cannot resurrect a cleared durable map.
                    if (current.pendingEdits) {
                        next.pendingEdits = current.pendingEdits;
                    } else {
                        delete next.pendingEdits;
                    }
                    // Excel header overrides are host-owned. A delayed debounced
                    // layout snapshot from this or another tab must not undo one.
                    if (current.excelFirstRowHeaders) {
                        next.excelFirstRowHeaders = current.excelFirstRowHeaders;
                    } else {
                        delete next.excelFirstRowHeaders;
                    }
                    if (current.excelFirstRowHeaderActive) {
                        next.excelFirstRowHeaderActive = current.excelFirstRowHeaderActive;
                    } else {
                        delete next.excelFirstRowHeaderActive;
                    }
                    if (current.excelFirstRowHeaderVersion === 1) {
                        next.excelFirstRowHeaderVersion = 1;
                    } else {
                        delete next.excelFirstRowHeaderVersion;
                    }
                    return next;
                }, undefined, () => (
                    !disposed
                    && file_coordinator.state_write_is_current(expected_authority)
                    && source_authority.authorityRevision === expected_authority
                    && msg.sourceGeneration === core?.source_generation
                    && (!uses_snapshots || (
                        msg.snapshotIdentity !== undefined
                        && session.acknowledged_identity() !== undefined
                        && same_snapshot_identity(
                            msg.snapshotIdentity,
                            session.acknowledged_identity()!,
                        )
                    ))
                ));
                return;
            }
            case 'setExcelFirstRowHeader': {
                const fail = async (error: string) => {
                    await panel.webview.postMessage({
                        type: 'excelFirstRowHeaderError',
                        requestId: msg.requestId,
                        error,
                    });
                };
                if (
                    disposed
                    || !(source instanceof ExcelHeaderDataSource)
                    || !core
                ) {
                    await fail('First-row headers are only available for Excel worksheets.');
                    return;
                }
                if (
                    source_authority.authorityRevision
                        !== file_coordinator.authority().authorityRevision
                    || msg.generation !== core.generation
                    || msg.sourceGeneration !== core.source_generation
                ) {
                    await fail('The worksheet changed before the header request arrived.');
                    return;
                }
                const sheet = source.meta().sheets[msg.sheetIndex];
                if (!sheet || sheet.name !== msg.sheetName) {
                    await fail('The selected worksheet no longer matches this request.');
                    return;
                }
                const header = sheet.excelFirstRowHeader;
                if (!header) {
                    await fail('First-row headers are only available for Excel worksheets.');
                    return;
                }
                if (msg.enabled && !header.available) {
                    await fail('This worksheet has no first row to use as column names.');
                    return;
                }

                const command_source = source;
                const expected_physical_revision = source_authority.physicalRevision;
                const result = await file_coordinator.commit_excel_header({
                    requestId: msg.requestId,
                    sheetIndex: msg.sheetIndex,
                    sheetName: msg.sheetName,
                    override: msg.enabled ? 'on' : 'off',
                    originToken: excel_header_subscriber_token,
                    expectedPhysicalRevision: expected_physical_revision,
                    planningInput: command_source.planning_input(),
                    stateStore: durable_state_store,
                });
                if (result.type === 'rejected' && !disposed) {
                    await fail(result.error);
                }
                return;
            }
            case 'setColumnVisibility': {
                const expected_authority = source_authority.authorityRevision;
                await update_file_state((current) => {
                        if (
                            !source
                            || !core
                            || !file_coordinator.state_write_is_current(expected_authority)
                            || source_authority.authorityRevision !== expected_authority
                            || msg.sourceGeneration !== core.source_generation
                        ) {
                            return current;
                        }
                        const sheet = source.meta().sheets[msg.sheetIndex];
                        if (!sheet || sheet.name !== msg.sheetName) return current;
                        const columnVisibility = [...(current.columnVisibility ?? [])];
                        columnVisibility[msg.sheetIndex] = sanitize_column_visibility_state(
                            msg.state,
                            sheet.columnCount,
                            transform_schema_for_sheet(sheet),
                        );
                    return { ...current, columnVisibility };
                }, undefined, () => (
                    file_coordinator.state_write_is_current(expected_authority)
                    && source_authority.authorityRevision === expected_authority
                    && msg.sourceGeneration === core?.source_generation
                ));
                return;
            }
            case 'requestEditSession': {
                const can_edit = profile.editing
                    && !!source
                    && !source.truncationMessage
                    && !(core?.has_transform_work ?? false);
                const owner = active_csv_edit_sessions.get(file_key);
                const denied_by_owner = can_edit
                    && owner !== undefined
                    && owner !== edit_session_token;
                const denied_by_transform = profile.editing
                    && !!source
                    && !source.truncationMessage
                    && (core?.has_transform_work ?? false);
                const granted = can_edit && !denied_by_owner && try_claim_edit_session();
                const edit_state = granted ? await read_file_state() : undefined;
                if (edit_state) update_session_state_material(edit_state);
                const pendingEdits = granted
                    ? (edit_state?.state as PerFileState | undefined)?.pendingEdits
                    : undefined;
                panel.webview.postMessage({
                    type: 'editSessionResult',
                    granted,
                    ...(pendingEdits ? { pendingEdits } : {}),
                });
                if (denied_by_owner) {
                    vscode.window.showWarningMessage(
                        'This file is already being edited in another Table Viewer tab.');
                } else if (denied_by_transform) {
                    vscode.window.showWarningMessage(
                        'Clear sorting and filters before entering edit mode.');
                }
                return;
            }
            case 'setTransform':
                if (profile.editing && owns_edit_session()) {
                    await core?.reject_transform(
                        msg,
                        'Exit edit mode before sorting or filtering.',
                    );
                    return;
                }
                transform_authorities.set(
                    msg.requestId,
                    source_authority.authorityRevision,
                );
                try {
                    await core?.handle_message(msg);
                } finally {
                    transform_authorities.delete(msg.requestId);
                }
                return;
            case 'releaseEditSession':
                if (profile.editing) {
                    release_edit_session();
                    if (uses_snapshots) await refresh_session_state_material(false);
                }
                return;
            case 'discardEditSession':
                if (profile.editing && owns_edit_session()) {
                    await clear_pending_edits();
                    release_edit_session();
                }
                return;
            case 'showWarning':
                vscode.window.showWarningMessage(msg.message);
                return;
            case 'saveCsv':
                if (profile.editing && owns_edit_session()) {
                    await handle_save(msg.edits);
                } else if (profile.editing) {
                    panel.webview.postMessage({ type: 'saveResult', success: false });
                }
                return;
            case 'pendingEditsChanged': {
                if (!profile.editing) return;
                if (!owns_edit_session()) return;
                if (msg.edits) {
                    const edits = msg.edits;
                    await update_file_state((current) => ({
                        ...current,
                        pendingEdits: edits,
                    }));
                } else {
                    await clear_pending_edits();
                }
                return;
            }
            case 'showSaveDialog': {
                if (!profile.editing || !owns_edit_session()) return;
                const choice = await vscode.window.showWarningMessage(
                    'You have unsaved changes.', { modal: true }, 'Save', 'Discard');
                panel.webview.postMessage({
                    type: 'saveDialogResult',
                    choice: choice === 'Save' ? 'save' : choice === 'Discard' ? 'discard' : 'cancel',
                });
                return;
            }
            default:
                if (
                    msg.type === 'visibleRowChanged'
                    && uses_snapshots
                    && !session.acknowledged_current()
                ) return;
                if (profile.on_message && await profile.on_message(msg)) return;
                await core?.handle_message(msg);
        }
    }));

    const dir = path.dirname(file_path);
    const basename = path.basename(file_path);
    const watcher = vscode.workspace.createFileSystemWatcher(
        new vscode.RelativePattern(vscode.Uri.file(dir), basename));
    const handle_watcher_event = () => {
        if (uses_snapshots) session.wake_delivery();
        return send_reload();
    };
    disposables.push(watcher.onDidChange(handle_watcher_event));
    disposables.push(watcher.onDidCreate(handle_watcher_event));
    disposables.push(watcher);

    return {
        dispose() {
            if (disposed) return;
            disposed = true;
            reload_seq++;
            reset_reload_retry();
            cancel_terminal_retry_waits();
            cancel_ready_state_retry_waits();
            outstanding_header_settlement = undefined;
            let first_error: unknown;
            const cleanup = (action: () => void) => {
                try {
                    action();
                } catch (error) {
                    first_error ??= error;
                }
            };
            cleanup(release_edit_session);
            cleanup(() => session.dispose());
            core = undefined;
            source = undefined;
            for (const d of disposables) cleanup(() => d.dispose());
            cleanup(() => file_coordinator.dispose());
            if (first_error !== undefined) throw first_error;
        },
    };
}
