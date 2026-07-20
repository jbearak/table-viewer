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
import {
    get_csv_max_rows, get_default_orientation, get_delimiter, get_max_file_size_mib,
} from './viewer-config';
import { assert_safe_file_size, MAX_CSV_ROWS } from './spreadsheet-safety';
import { serialize_csv } from './serialize-csv';
import type {
    AuthorityFileStateStore,
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
} from './file-coordinator';
import { reconcile_finalization } from './finalization-reconciliation';
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
    return { editing: true, build_source: build_csv_source };
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

    let core: ViewerPanelCore | undefined;
    let source: DataSource | undefined;
    let source_authority = file_coordinator.authority();
    const transform_authorities = new Map<string, number>();
    let reload_seq = 0;
    let disposed = false;
    let initial_meta_sent = false;
    let ready_seen = false;
    let adopted_digest: string | undefined;
    let delivered_digest: string | undefined;
    let delivered_authority_revision = source_authority.authorityRevision;
    let delivered_generation: number | undefined;
    let delivered_source_generation: number | undefined;
    let reload_retry_attempts = 0;
    let reload_retry_timer: ReturnType<typeof setTimeout> | undefined;
    const terminal_retry_waits = new Set<{
        timer: ReturnType<typeof setTimeout>;
        resolve: (proceed: boolean) => void;
    }>();
    let outstanding_header_settlement: HeaderSettlement | undefined;
    const edit_session_token = Symbol(file_key);
    const excel_header_subscriber_token = Symbol(file_key);

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
    ): Promise<boolean> {
        let snapshot = await read_file_state();
        for (;;) {
            const current = normalize_host_state(snapshot.state, sheet_names);
            const next = updater(current);
            if (next === current) return false;
            const result = await state_store.compare_and_set(
                state_path,
                snapshot.revision,
                next,
                validate,
            );
            if (result.type === 'committed') return true;
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

    async function build_source(): Promise<{
        source: DataSource;
        digest: string;
        snapshot: string;
    }> {
        const state = (await read_file_state()).state as PerFileState;
        const stat = await vscode.workspace.fs.stat(uri);
        const max_mib = get_max_file_size_mib();
        assert_safe_file_size(stat.size, max_mib);
        const raw = await vscode.workspace.fs.readFile(uri);
        assert_safe_file_size(raw.byteLength, max_mib);
        return {
            source: await profile.build_source(raw, file_path, state),
            digest: content_digest(raw),
            snapshot: `${stat.mtime}:${stat.size}`,
        };
    }

    function discard_stale_built_source(
        ds: DataSource,
        seq: number,
        force = false,
        header_recovery?: ExcelHeaderRecovery,
    ): void {
        ds.close();
        if (!header_recovery) schedule_reload_retry(force, seq);
    }

    async function built_source_is_current(
        seq: number,
        snapshot: string,
        digest: string,
    ): Promise<boolean> {
        if (disposed || seq !== reload_seq) return false;
        const stat = await vscode.workspace.fs.stat(uri);
        if (
            disposed
            || seq !== reload_seq
            || `${stat.mtime}:${stat.size}` !== snapshot
        ) {
            return false;
        }
        const raw = await vscode.workspace.fs.readFile(uri);
        const verified_stat = await vscode.workspace.fs.stat(uri);
        return !disposed
            && seq === reload_seq
            && `${verified_stat.mtime}:${verified_stat.size}` === snapshot
            && content_digest(raw) === digest;
    }

    async function reserve_and_prepare_adoption(
        ds: DataSource,
        seq: number,
        snapshot: string,
        digest: string,
        expected_authority_revision: number,
        already_verified = false,
        adopt_candidate = true,
    ): Promise<boolean> {
        if (
            !already_verified
            && !await built_source_is_current(seq, snapshot, digest)
        ) return false;
        const started = file_coordinator.begin_physical(
            expected_authority_revision,
            digest,
        );
        if (started.type === 'rejected') return false;
        const { token } = started;
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
                ) return false;
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
                if (staged.type === 'conflict') continue;
                const requested = await file_coordinator.request_commit_turn(token);
                if (requested.type === 'rejected') return false;
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
                        if (plan && ds instanceof ExcelHeaderDataSource) {
                            ds.replace_overrides(plan.overrides);
                        }
                        const receipt = file_coordinator.finalize_authority_commit(
                            token,
                            requested.turn,
                            reconciled,
                        );
                        return adopt_candidate
                            ? adopt(ds, digest, receipt.resultingBasis)
                            : true;
                    }
                    if (reconciled.type === 'advanced') {
                        file_coordinator.observe_advanced_authority(
                            token,
                            requested.turn,
                            reconciled.authority,
                        );
                        return false;
                    }
                    file_coordinator.release_commit_turn(requested.turn);
                    void discard_authority(durable_state_store, state_path, token.id);
                    throw error;
                }
                if (finalized.type === 'conflict') {
                    file_coordinator.release_commit_turn(requested.turn);
                    continue;
                }
                if (plan && ds instanceof ExcelHeaderDataSource) {
                    ds.replace_overrides(plan.overrides);
                }
                const receipt = file_coordinator.finalize_authority_commit(
                    token,
                    requested.turn,
                    finalized,
                );
                return adopt_candidate
                    ? adopt(ds, digest, receipt.resultingBasis)
                    : true;
            }
        } finally {
            file_coordinator.cancel(token);
            void discard_authority(durable_state_store, state_path, token.id);
        }
    }

    function adopt(
        ds: DataSource,
        digest: string,
        authority: FileAuthoritySnapshot,
    ): boolean {
        // Snapshot/state linearization may legitimately complete after a newer file
        // event, but panel disposal is an absolute lifecycle boundary. Refuse the
        // fresh candidate before installing a core/source and own its single close.
        if (disposed) return false;
        core = adopt_source_into_core(core, panel, source, ds, {
            onTransformCommit: persist_transform_commit,
        });
        source = ds;
        source_authority = authority;
        adopted_digest = digest;
        profile.on_source_adopted?.(ds);
        return true;
    }

    function close_unadopted_candidate(candidate: DataSource | undefined): void {
        if (candidate && candidate !== source) candidate.close();
    }

    function metadata_is_delivered(): boolean {
        return initial_meta_sent
            && core !== undefined
            && adopted_digest === delivered_digest
            && source_authority.authorityRevision === delivered_authority_revision
            && source_authority.authorityRevision
                === file_coordinator.authority().authorityRevision
            && core.generation === delivered_generation
            && core.source_generation === delivered_source_generation;
    }

    function mark_metadata_delivered(seq?: number): void {
        delivered_digest = adopted_digest;
        delivered_authority_revision = source_authority.authorityRevision;
        delivered_generation = core?.generation;
        delivered_source_generation = core?.source_generation;
        // A direct header projection delivery is not completion of an unrelated
        // physical-file reload episode. Only that episode's own successful post
        // may clear its retry timer and budget.
        if (seq !== undefined && seq === reload_seq) reset_reload_retry();
    }

    async function state_for_reload(ds: DataSource): Promise<PerFileState> {
        return normalize_per_file_state(
            (await read_file_state()).state,
            ds.meta().sheets.map((sheet) => sheet.name),
        );
    }

    async function state_for_first_meta(): Promise<PerFileState> {
        const state = (await read_file_state()).state as PerFileState;
        if (!profile.editing || !state.pendingEdits) return state;
        if (try_claim_edit_session()) return state;
        const { pendingEdits: _drop, ...rest } = state;
        return rest;
    }

    async function send_first_meta(
        ds: DataSource,
        committed_state?: PerFileState,
    ): Promise<boolean> {
        const settlement = outstanding_header_settlement;
        const delivered = await core!.send_meta({
            state: committed_state ?? await state_for_first_meta(),
            defaultTabOrientation: get_default_orientation(),
            previewMode: profile.previewMode,
            ...editing_flags(ds),
            projectionChange: settlement ? 'excelHeader' : undefined,
            headerRequestId: settlement?.requestId,
            error: settlement?.error,
        });
        if (
            delivered
            && ready_seen
            && settlement === outstanding_header_settlement
        ) {
            outstanding_header_settlement = undefined;
        }
        return delivered;
    }

    async function post_reload(
        ds: DataSource,
        projectionChange?: 'excelHeader',
        headerRequestId?: string,
        state?: PerFileState,
    ): Promise<boolean> {
        const settlement = outstanding_header_settlement;
        const delivered = await core!.send_meta_reload({
            ...editing_flags(ds),
            projectionChange: settlement ? 'excelHeader' : projectionChange,
            headerRequestId: settlement?.requestId ?? headerRequestId,
            state: settlement ? (state ?? await state_for_reload(ds)) : state,
        });
        if (delivered && settlement === outstanding_header_settlement) {
            outstanding_header_settlement = undefined;
        }
        return delivered;
    }

    async function post_header_projection(
        ds: DataSource,
        request_id: string,
        committed_state?: PerFileState,
    ): Promise<boolean> {
        if (!initial_meta_sent) {
            const delivered = await send_first_meta(ds, committed_state);
            if (delivered && ready_seen) initial_meta_sent = true;
            return delivered;
        }
        return post_reload(
            ds,
            'excelHeader',
            request_id,
            committed_state ?? await state_for_reload(ds),
        );
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
        // The projected source object is intentionally reused. set_source still
        // invalidates source generations, transforms, and row-window caches.
        core.set_source(source);
        source_authority = receipt.resultingBasis;
        const attempts = is_origin ? HEADER_RELOAD_RETRY_COUNT : 1;
        for (let attempt = 0; attempt < attempts; attempt++) {
            if (
                disposed
                || source_authority.authorityRevision
                    !== receipt.resultingBasis.authorityRevision
            ) return;
            try {
                if (await post_header_projection(
                    source,
                    receipt.requestId,
                    receipt.stateSnapshot.state as PerFileState,
                )) {
                    mark_metadata_delivered();
                    return;
                }
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
        await update_file_state((current) => {
            const { pendingEdits: _drop, ...rest } = current;
            return rest;
        });
    }

    async function send_initial_data(): Promise<void> {
        reset_reload_retry();
        const seq = ++reload_seq;
        let candidate: DataSource | undefined;
        try {
            const expected_authority = file_coordinator.authority().authorityRevision;
            const { source: ds, digest, snapshot } = await build_source();
            candidate = ds;
            if (!await reserve_and_prepare_adoption(
                ds, seq, snapshot, digest, expected_authority,
            )) {
                discard_stale_built_source(ds, seq, true);
                return;
            }
            if (await send_first_meta(ds)) {
                initial_meta_sent = true;
                mark_metadata_delivered(seq);
                surface_warnings(ds);
            } else {
                schedule_reload_retry(true, seq);
            }
        } catch (err) {
            close_unadopted_candidate(candidate);
            if (disposed) return;
            if (!schedule_reload_retry(true, seq)) {
                vscode.window.showErrorMessage(err instanceof Error ? err.message : String(err));
            }
        }
    }

    // Build explicit refreshes before superseding watcher work. A transient
    // post-save read/parse failure therefore cannot invalidate the only viable
    // watcher refresh. The pre-adoption failures and later unstable-snapshot
    // failures share one bounded retry budget.
    async function reparse_and_post(): Promise<boolean> {
        const expected_authority = file_coordinator.authority().authorityRevision;
        let built: Awaited<ReturnType<typeof build_source>>;
        let attempts = 0;
        for (;;) {
            if (disposed) return false;
            try {
                built = await build_source();
                break;
            } catch (error) {
                if (disposed || attempts >= RELOAD_RETRY_COUNT) throw error;
                attempts += 1;
                await delay(RELOAD_RETRY_MS);
            }
        }
        if (disposed) {
            built.source.close();
            return false;
        }
        reset_reload_retry();
        reload_retry_attempts = attempts;
        const seq = ++reload_seq;
        const { source: ds, digest, snapshot } = built;
        let delivered = false;
        try {
            if (!await reserve_and_prepare_adoption(
                ds, seq, snapshot, digest, expected_authority,
            )) {
                discard_stale_built_source(ds, seq, true);
                return false;
            }
            try {
                delivered = await post_reload(ds);
            } catch (error) {
                if (!schedule_reload_retry(true, seq)) throw error;
                return false;
            }
            if (delivered) {
                mark_metadata_delivered(seq);
            } else {
                schedule_reload_retry(true, seq);
            }
        } catch (error) {
            close_unadopted_candidate(ds);
            throw error;
        }
        return delivered;
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
        let candidate: DataSource | undefined;
        try {
            let expected_authority = file_coordinator.authority().authorityRevision;
            const { source: ds, digest, snapshot } = await build_source();
            candidate = ds;
            if (
                header_recovery
                && outstanding_header_settlement !== header_recovery.settlement
            ) {
                ds.close();
                delivered = true;
                return delivered;
            }
            if (!await built_source_is_current(seq, snapshot, digest)) {
                discard_stale_built_source(ds, seq, force, header_recovery);
                return delivered;
            }
            // Deduplicate only when the webview has actually received metadata
            // for the currently adopted source and both core generations.
            if (
                !force
                && outstanding_header_settlement === undefined
                && digest === delivered_digest
                && metadata_is_delivered()
            ) {
                if (await reserve_and_prepare_adoption(
                    ds, seq, snapshot, digest, expected_authority, true, false,
                )) {
                    ds.close();
                    mark_metadata_delivered(seq);
                    return true;
                }
                expected_authority = file_coordinator.authority().authorityRevision;
            }
            if (!await reserve_and_prepare_adoption(
                ds, seq, snapshot, digest, expected_authority, true,
            )) {
                discard_stale_built_source(ds, seq, force, header_recovery);
                return delivered;
            }
            if (!initial_meta_sent) {
                delivered = await send_first_meta(ds);
                if (!delivered) {
                    if (!header_recovery) schedule_reload_retry(force, seq);
                    return delivered;
                }
                if (ready_seen) initial_meta_sent = true;
                mark_metadata_delivered(header_recovery ? undefined : seq);
                surface_warnings(ds);
                return delivered;
            }
            delivered = await post_reload(
                ds,
                header_recovery ? 'excelHeader' : undefined,
                header_recovery?.requestId,
                header_recovery ? await state_for_reload(ds) : undefined,
            );
            if (!delivered) {
                if (!header_recovery) schedule_reload_retry(force, seq);
                return delivered;
            }
            mark_metadata_delivered(header_recovery ? undefined : seq);
            surface_warnings(ds);
        } catch (err) {
            close_unadopted_candidate(candidate);
            if (disposed || header_recovery) return false;
            if (schedule_reload_retry(force, seq)) return false;
            console.error('Failed to reload table viewer data', err);
            vscode.window.showErrorMessage(
                `Failed to reload: ${err instanceof Error ? err.message : String(err)}`);
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
            let delivered = false;
            let delivered_settlement: typeof tracked_settlement | undefined;
            if (outstanding_header_settlement !== tracked_settlement) return true;
            if (
                disposed
                || !core
                || !source
                || source_authority.authorityRevision
                    !== file_coordinator.authority().authorityRevision
            ) return false;
            try {
                if (!initial_meta_sent) {
                    delivered = await send_first_meta(source);
                    if (delivered && ready_seen) initial_meta_sent = true;
                } else {
                    delivered = await core.send_meta_recovery({
                        state: await state_for_reload(source),
                        ...editing_flags(source),
                        headerRequestId: tracked_settlement.requestId,
                        error: tracked_settlement.error,
                    });
                }
            } catch {
                delivered = false;
            }
            if (delivered) {
                delivered_settlement = tracked_settlement;
                mark_metadata_delivered();
                surface_warnings(source);
            }
            if (delivered) {
                if (
                    initial_meta_sent
                    && delivered_settlement === outstanding_header_settlement
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
            const expected_digest = adopted_digest;
            if (
                expected_digest === undefined
                || !metadata_is_delivered()
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
            if (snapshot_changed || content_digest(current_raw) !== expected_digest) {
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
            // The write succeeded — the save is done. A failure to re-parse the
            // just-written file (a transient read error, or an external delete in
            // the TOCTOU window) must not be reported as a failed save: the bytes
            // are on disk. The adopted digest changes only after a successful reparse, so
            // the watcher event from our own write still refreshes the grid here.
            try {
                await reparse_and_post();
            } catch (reload_err) {
                console.error('Post-save reload failed (file was written)', reload_err);
            }
            await clear_pending_edits();
            panel.webview.postMessage({ type: 'saveResult', success: true });
        } catch (err) {
            vscode.window.showErrorMessage(
                `Failed to save: ${err instanceof Error ? err.message : String(err)}`);
            panel.webview.postMessage({ type: 'saveResult', success: false });
        }
    }

    disposables.push(panel.webview.onDidReceiveMessage(async (msg: WebviewMessage) => {
        if (disposed) return;
        switch (msg.type) {
            case 'ready':
                ready_seen = true;
                await send_initial_data();
                return;
            case 'stateChanged': {
                const expected_authority = source_authority.authorityRevision;
                await update_file_state((current) => {
                        if (
                            disposed
                            || !core
                            || !file_coordinator.state_write_is_current(expected_authority)
                            || source_authority.authorityRevision !== expected_authority
                            || msg.sourceGeneration !== core.source_generation
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
                    // Pending edits are host-owned for editable profiles. Preserve
                    // the current map when present, and delete stale snapshots after
                    // save/discard has durably cleared it.
                    if (profile.editing) {
                        if (current.pendingEdits) {
                            next.pendingEdits = current.pendingEdits;
                        } else {
                            delete next.pendingEdits;
                        }
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
                const pendingEdits = granted
                    ? ((await read_file_state()).state as PerFileState).pendingEdits
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
                if (profile.editing) release_edit_session();
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
                if (profile.on_message && await profile.on_message(msg)) return;
                await core?.handle_message(msg);
        }
    }));

    const dir = path.dirname(file_path);
    const basename = path.basename(file_path);
    const watcher = vscode.workspace.createFileSystemWatcher(
        new vscode.RelativePattern(vscode.Uri.file(dir), basename));
    disposables.push(watcher.onDidChange(() => send_reload()));
    disposables.push(watcher.onDidCreate(() => send_reload()));
    disposables.push(watcher);

    return {
        dispose() {
            if (disposed) return;
            disposed = true;
            reload_seq++;
            reset_reload_retry();
            cancel_terminal_retry_waits();
            outstanding_header_settlement = undefined;
            release_edit_session();
            core?.dispose();
            source?.close();
            for (const d of disposables) d.dispose();
            file_coordinator.dispose();
        },
    };
}
