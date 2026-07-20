import { createHash } from 'crypto';
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
    type FileAuthoritySnapshot,
    type FileRefreshEvent,
    type FileRefreshSubscriberResult,
    type PhysicalAuthorityCommitReceipt,
} from './file-coordinator';
import { vscode_file_refresh_watcher_factory } from './vscode-file-refresh-watcher';
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
import { sanitize_transform_state } from './webview/sheet-state';
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
const RELOAD_RETRY_COUNT = 3;
const RELOAD_RETRY_MS = 50;
const READY_STATE_RETRY_COUNT = 3;
const READY_STATE_RETRY_MS = 50;

function content_digest(bytes: Uint8Array): string {
    return createHash('sha256').update(bytes).digest('hex');
}

function delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
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

function same_file_authority_basis(
    left: FileAuthoritySnapshot,
    right: FileAuthoritySnapshot,
): boolean {
    return left.fileKey === right.fileKey
        && left.commitSequence === right.commitSequence
        && left.authorityRevision === right.authorityRevision
        && left.physicalRevision === right.physicalRevision
        && left.projectionRevision === right.projectionRevision
        && left.physicalDigest === right.physicalDigest;
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

    // Borrowed aliases are updated only at the same synchronous boundary as the
    // session adoption. PanelSession remains the sole source/core lifecycle owner.
    let core: ViewerPanelCore | undefined;
    let source: DataSource | undefined;
    let source_authority = file_coordinator.authority();
    const transform_authorities = new Map<string, number>();
    let load_seq = 0;
    let latest_refresh_event: FileRefreshEvent | undefined;
    let disposed = false;
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
    const edit_session_token = Symbol(file_key);
    const excel_header_subscriber_token = Symbol(file_key);
    const header_receipt_queue: ExcelHeaderOperationReceipt[] = [];
    let header_receipt_processing = false;
    let header_refresh_scheduled = false;
    const released_sources = new WeakSet<DataSource>();
    const released_cores = new WeakSet<ViewerPanelCore>();

    const session = new PanelSession({
        postMessage: (message) => panel.webview.postMessage(message),
        onNeedsResyncSource: () => { void refresh_panel_source(true); },
        onCurrentAdoptionAcknowledged: (adoption) => {
            if (disposed || session.current_adoption() !== adoption) return;
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

    // Subscribe before the panel can become ready. Coordinator events may build
    // and install a panel-local source pre-ready; PanelSession defers delivery.
    disposables.push(file_coordinator.subscribe_refresh(
        refresh_from_event,
        vscode_file_refresh_watcher_factory,
    ));

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
        session.update_state_snapshot(project_state_for_panel(snapshot, allow_claim));
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
        refresh_event?: FileRefreshEvent,
    ): Promise<boolean> {
        if (!load_is_current(seq, refresh_event)) return false;
        const { fingerprint, digest } = candidate.observation;
        const stat = await vscode.workspace.fs.stat(uri);
        if (
            !load_is_current(seq, refresh_event)
            || `${stat.mtime}:${stat.size}` !== fingerprint
        ) {
            return false;
        }
        const raw = await vscode.workspace.fs.readFile(uri);
        const verified_stat = await vscode.workspace.fs.stat(uri);
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
        const sheet_names = planning_input?.sheets.map((sheet) => sheet.name) ?? [];
        try {
            for (;;) {
                if (
                    !load_is_current(seq, refresh_event)
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
        }
        let adopted: DataSource | undefined;
        const transferred = candidate.transfer_to((next, confirm_transfer) => {
            if (!load_is_current(seq, refresh_event)) return;
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
                        receipt.resultingBasis.authorityRevision
                            < source_authority.authorityRevision
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
                    );
                    const current_adoption = session.current_adoption();
                    if (
                        exact_basis
                        && core
                        && source instanceof ExcelHeaderDataSource
                        && current_adoption?.resources.source === source
                        && current_adoption.resources.core === core
                        && source.set_override(receipt.sheetName, receipt.override)
                    ) {
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
                                        defaultTabOrientation: get_default_orientation(),
                                        previewMode: profile.previewMode === true,
                                    },
                                    capabilities: {
                                        csvEditingSupported: profile.editing,
                                        csvEditable: profile.editing && !source!.truncationMessage,
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
                    console.error('Failed to apply an Excel header receipt', error);
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

    disposables.push(file_coordinator.subscribe_excel_headers(
        enqueue_excel_header_receipt,
    ));

    // CSV pending-edit persistence deliberately remains on FileStateStore's CAS
    // queue in this phase. Edit-session ownership is separate from file authority;
    // physical/projection/layout writes use the coordinator serialization above.
    async function clear_pending_edits(): Promise<void> {
        const committed = await update_file_state((current) => {
            if (!current.pendingEdits) return current;
            const { pendingEdits: _drop, ...rest } = current;
            return rest;
        });
        if (!committed) await refresh_session_state_material();
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

    function report_refresh_failure(error: unknown, initial: boolean): void {
        if (initial) {
            void vscode.window.showErrorMessage(
                error instanceof Error ? error.message : String(error));
            return;
        }
        console.error('Failed to reload table viewer data', error);
        void vscode.window.showErrorMessage(
            `Failed to reload: ${error instanceof Error ? error.message : String(error)}`);
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
                report_refresh_failure(last_error, initial);
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
                schedule_local_refresh_retry(request, force, reason, initial);
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
                schedule_local_refresh_retry(request, force, reason, initial);
                return false;
            }
            const committed = await commit_physical_candidate(
                candidate, request.seq, expected_authority, true,
            );
            if (committed.type !== 'committed') {
                schedule_local_refresh_retry(request, force, reason, initial);
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
        return run_physical_refresh(request, false, 'fileReload');
    }

    async function send_initial_data(): Promise<void> {
        await refresh_panel_source(true, 'ready', true);
    }

    // Build the direct post-save/conflict refresh before superseding watcher work.
    // Phase 5.3 will publish these refreshes through the coordinator; for now a
    // transient post-save read/parse failure leaves a viable watcher load intact.
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
            const seq = supersede_panel_load();
            reload_retry_attempts = attempts;
            const committed = await commit_physical_candidate(
                candidate, seq, expected_authority,
            );
            if (committed.type !== 'committed') {
                schedule_direct_refresh_retry(seq);
                return false;
            }
            return adopt_committed_candidate(
                candidate,
                committed,
                seq,
                reason,
                profile.editing ? await read_file_state() : undefined,
            ) !== undefined;
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

    function schedule_direct_refresh_retry(seq: number): boolean {
        return schedule_local_refresh_retry(
            { seq },
            true,
            'recovery',
            false,
        );
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

    async function handle_save(edits: Record<string, string>): Promise<void> {
        if (!source) return;
        if (source.truncationMessage) {
            panel.webview.postMessage({ type: 'saveResult', success: false });
            return;
        }
        try {
            const current_adoption = session.current_adoption();
            const expected_digest = session.acknowledged_physical_digest();
            if (
                expected_digest === undefined
                || !session.acknowledged_current()
                || current_adoption?.resources.source !== source
                || current_adoption.resources.core !== core
                || source_authority.authorityRevision
                    !== file_coordinator.authority().authorityRevision
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
                || !session.acknowledged_current()
                || session.current_adoption() !== current_adoption
                || current_adoption?.resources.source !== src
                || current_adoption.resources.core !== core
                || source_authority.authorityRevision
                    !== file_coordinator.authority().authorityRevision
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
            msg.type !== 'ready'
            && msg.type !== 'snapshotApplied'
            && msg.type !== 'showWarning'
        ) {
            session.wake_delivery();
        }
        switch (msg.type) {
            case 'ready': {
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
                session.handle_snapshot_applied(msg.identity, msg.disposition);
                return;
            case 'stateChanged': {
                const expected_authority = source_authority.authorityRevision;
                const acknowledged_identity = session.acknowledged_identity();
                const native_identity_is_current = msg.snapshotIdentity !== undefined
                    && acknowledged_identity !== undefined
                    && same_snapshot_identity(msg.snapshotIdentity, acknowledged_identity);
                if (!native_identity_is_current) return;
                await update_file_state((current) => {
                        if (
                            disposed
                            || !core
                            || !file_coordinator.state_write_is_current(expected_authority)
                            || source_authority.authorityRevision !== expected_authority
                            || msg.sourceGeneration !== core.source_generation
                            || msg.snapshotIdentity === undefined
                            || session.acknowledged_identity() === undefined
                            || !same_snapshot_identity(
                                msg.snapshotIdentity,
                                session.acknowledged_identity()!,
                            )
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
                    && msg.snapshotIdentity !== undefined
                    && session.acknowledged_identity() !== undefined
                    && same_snapshot_identity(
                        msg.snapshotIdentity,
                        session.acknowledged_identity()!,
                    )
                ));
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
                const header = sheet.excelFirstRowHeader;
                if (!header) {
                    fail('First-row headers are only available for Excel worksheets.');
                    return;
                }
                if (msg.enabled && !header.available) {
                    fail('This worksheet has no first row to use as column names.');
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
                    fail(result.error);
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
                    await refresh_session_state_material(false);
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
                    && !session.acknowledged_current()
                ) return;
                if (profile.on_message && await profile.on_message(msg)) return;
                await core?.handle_message(msg);
        }
    }));

    return {
        dispose() {
            if (disposed) return;
            disposed = true;
            load_seq++;
            reset_reload_retry();
            cancel_refresh_retry_wait();
            cancel_ready_state_retry_waits();
            header_receipt_queue.length = 0;
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
