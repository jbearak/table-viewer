import { createHash } from 'crypto';
import * as path from 'path';
import * as vscode from 'vscode';
import { XlsxDataSource } from './data-source/xlsx-source';
import { XlsDataSource } from './data-source/xls-source';
import { CsvDataSource } from './data-source/csv-source';
import { ExcelHeaderDataSource } from './data-source/excel-header-source';
import type {
    DataSource,
    ExcelHeaderOverride,
    RenderedCell,
} from './data-source/interface';
import { ViewerPanelCore, adopt_source_into_core, type PanelLike } from './panel-core';
import {
    get_csv_max_rows, get_default_orientation, get_delimiter, get_max_file_size_mib,
} from './viewer-config';
import { assert_safe_file_size, MAX_CSV_ROWS } from './spreadsheet-safety';
import { serialize_csv } from './serialize-csv';
import type { FileStateStore, FileStateTransactionDecision } from './state';
import {
    sanitize_excel_header_active,
    sanitize_excel_header_overrides,
    transform_has_entries,
    transform_schema_for_sheet,
    type PerFileState,
    type SheetTransformState,
    type StoredPerFileState,
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

interface ExcelHeaderSubscriber {
    token: symbol;
    refresh(
        sheet_name: string,
        override: ExcelHeaderOverride,
        previous_file_epoch: number,
        file_epoch: number,
        request_id: string,
        is_origin: boolean,
    ): Promise<boolean>;
}
const excel_header_subscribers = new Map<string, Set<ExcelHeaderSubscriber>>();

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

interface FileMutationContext {
    epoch: number;
    revision?: string;
    pending: Promise<void>;
    attachments: number;
    operations: number;
}

const file_mutation_contexts = new Map<string, FileMutationContext>();

function file_mutation_context(file_path: string): FileMutationContext {
    let context = file_mutation_contexts.get(file_path);
    if (!context) {
        context = {
            epoch: 0,
            pending: Promise.resolve(),
            attachments: 0,
            operations: 0,
        };
        file_mutation_contexts.set(file_path, context);
    }
    return context;
}

function cleanup_file_mutation_context(
    file_path: string,
    context: FileMutationContext,
): void {
    if (
        context.attachments === 0
        && context.operations === 0
        && file_mutation_contexts.get(file_path) === context
    ) {
        file_mutation_contexts.delete(file_path);
    }
}

function run_file_mutation<T>(
    file_path: string,
    operation: () => Promise<T>,
): Promise<T> {
    const context = file_mutation_context(file_path);
    context.operations += 1;
    const result = context.pending.catch(() => {}).then(operation);
    context.pending = result.then(() => {}, () => {});
    void result.then(
        () => {
            context.operations -= 1;
            cleanup_file_mutation_context(file_path, context);
        },
        () => {
            context.operations -= 1;
            cleanup_file_mutation_context(file_path, context);
        },
    );
    return result;
}

function establish_file_revision(file_path: string, revision: string): number {
    const context = file_mutation_context(file_path);
    if (context.revision === undefined) {
        context.revision = revision;
    } else if (context.revision !== revision) {
        context.revision = revision;
        context.epoch += 1;
    }
    return context.epoch;
}

function advance_file_epoch(file_path: string): number {
    const context = file_mutation_context(file_path);
    context.epoch += 1;
    return context.epoch;
}

function current_file_epoch(file_path: string): number {
    return file_mutation_context(file_path).epoch;
}

function acquire_file_mutation_context(file_path: string): FileMutationContext {
    const context = file_mutation_context(file_path);
    context.attachments += 1;
    return context;
}

function release_file_mutation_context(
    file_path: string,
    context: FileMutationContext,
): void {
    context.attachments = Math.max(0, context.attachments - 1);
    cleanup_file_mutation_context(file_path, context);
}

function subscribe_excel_headers(
    file_path: string,
    subscriber: ExcelHeaderSubscriber,
): vscode.Disposable {
    const subscribers = excel_header_subscribers.get(file_path) ?? new Set();
    subscribers.add(subscriber);
    excel_header_subscribers.set(file_path, subscribers);
    return {
        dispose() {
            subscribers.delete(subscriber);
            if (subscribers.size === 0) excel_header_subscribers.delete(file_path);
        },
    };
}

/**
 * Re-fingerprint one sheet's persisted view descriptor (transform or column
 * visibility) after a header toggle. Column indices are unchanged by the
 * toggle, so a descriptor that matched the old schema is rewritten to the new
 * one; anything else is left for the ordinary schema check to discard.
 */
function migrate_sheet_schema<T extends { schema?: string }>(
    entries: (T | undefined)[] | undefined,
    sheet_index: number,
    old_schema: string,
    new_schema: string | undefined,
): (T | undefined)[] | undefined {
    const entry = entries?.[sheet_index];
    if (!entries || !entry || entry.schema !== old_schema) return entries;
    const next = [...entries];
    next[sheet_index] = new_schema === undefined
        ? { ...entry, schema: undefined }
        : { ...entry, schema: new_schema };
    return next;
}

function excel_header_maps_equal(
    left: Record<string, boolean>,
    right: Record<string, boolean>,
): boolean {
    const left_entries = Object.entries(left);
    const right_entries = Object.entries(right);
    return left_entries.length === right_entries.length
        && left_entries.every(([name, active]) => (
            Object.prototype.hasOwnProperty.call(right, name)
            && right[name] === active
        ));
}

async function broadcast_excel_header(
    file_path: string,
    sheet_name: string,
    override: ExcelHeaderOverride,
    previous_file_epoch: number,
    file_epoch: number,
    request_id: string,
    origin_token: symbol,
): Promise<boolean> {
    const subscribers = [...(excel_header_subscribers.get(file_path) ?? [])];
    let origin_delivered = !subscribers.some(({ token }) => token === origin_token);
    await Promise.all(subscribers.map(async (subscriber) => {
        const is_origin = subscriber.token === origin_token;
        try {
            const delivered = await subscriber.refresh(
                sheet_name,
                override,
                previous_file_epoch,
                file_epoch,
                request_id,
                is_origin,
            );
            if (is_origin) {
                origin_delivered = delivered;
            } else if (!delivered) {
                console.error('Failed to refresh an Excel header view');
            }
        } catch (error) {
            if (is_origin) {
                origin_delivered = false;
            } else {
                console.error('Failed to refresh an Excel header view', error);
            }
        }
    }));
    return origin_delivered;
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
    state_store: FileStateStore,
    profile: ViewerProfile,
): vscode.Disposable {
    const file_path = uri.fsPath;
    const disposables: vscode.Disposable[] = [];
    const mutation_context = acquire_file_mutation_context(file_path);

    let core: ViewerPanelCore | undefined;
    let source: DataSource | undefined;
    let source_file_epoch = mutation_context.epoch;
    const transform_file_epochs = new Map<string, number>();
    let reload_seq = 0;
    let disposed = false;
    let initial_meta_sent = false;
    let ready_seen = false;
    let adopted_digest: string | undefined;
    let delivered_digest: string | undefined;
    let delivered_file_epoch = source_file_epoch;
    let delivered_generation: number | undefined;
    let delivered_source_generation: number | undefined;
    let reload_retry_attempts = 0;
    let reload_retry_timer: ReturnType<typeof setTimeout> | undefined;
    const terminal_retry_waits = new Set<{
        timer: ReturnType<typeof setTimeout>;
        resolve: (proceed: boolean) => void;
    }>();
    let outstanding_header_settlement: HeaderSettlement | undefined;
    const edit_session_token = Symbol(file_path);
    const excel_header_subscriber_token = Symbol(file_path);

    function owns_edit_session(): boolean {
        return active_csv_edit_sessions.get(file_path) === edit_session_token;
    }

    function try_claim_edit_session(): boolean {
        const owner = active_csv_edit_sessions.get(file_path);
        if (owner && owner !== edit_session_token) return false;
        active_csv_edit_sessions.set(file_path, edit_session_token);
        return true;
    }

    function release_edit_session(): void {
        if (owns_edit_session()) active_csv_edit_sessions.delete(file_path);
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

    function normalize_host_state(
        stored: StoredPerFileState,
        sheet_names: string[],
    ): PerFileState {
        const normalized = normalize_per_file_state(stored, sheet_names);
        if ('excelFirstRowHeaders' in stored) {
            normalized.excelFirstRowHeaders = sanitize_excel_header_overrides(
                stored.excelFirstRowHeaders,
            );
        }
        if ('excelFirstRowHeaderActive' in stored) {
            normalized.excelFirstRowHeaderActive = sanitize_excel_header_active(
                stored.excelFirstRowHeaderActive,
            );
        }
        if (
            'excelFirstRowHeaderVersion' in stored
            && stored.excelFirstRowHeaderVersion === 1
        ) {
            normalized.excelFirstRowHeaderVersion = 1;
        }
        return normalized;
    }

    async function update_file_state(
        updater: (current: PerFileState) => PerFileState,
        sheet_names = source?.meta().sheets.map((sheet) => sheet.name) ?? [],
    ): Promise<void> {
        if (state_store.update) {
            await state_store.update(
                file_path,
                (current) => updater(normalize_host_state(current, sheet_names)),
            );
            return;
        }
        await state_store.set(
            file_path,
            updater(normalize_host_state(state_store.get(file_path), sheet_names)),
        );
    }

    async function transact_file_state(
        decide: (current: PerFileState) => Promise<FileStateTransactionDecision>,
        sheet_names: string[],
    ): Promise<FileStateTransactionDecision['type']> {
        if (state_store.transaction) {
            return state_store.transaction(file_path, (current) =>
                decide(normalize_host_state(current, sheet_names)));
        }
        const decision = await decide(normalize_host_state(
            state_store.get(file_path),
            sheet_names,
        ));
        if (decision.type === 'commit') {
            await update_file_state(() => decision.state, sheet_names);
        }
        return decision.type;
    }

    async function persist_transform_commit(
        message: Extract<WebviewMessage, { type: 'setTransform' }>,
        state: SheetTransformState,
    ): Promise<void> {
        // Restores merely recompute host-owned preferences. Only explicit user
        // actions can replace those preferences, and the core awaits this write
        // before posting its terminal acknowledgement.
        if (message.intent === 'restore') return;
        const expected_file_epoch = transform_file_epochs.get(message.requestId);
        if (expected_file_epoch === undefined) return;
        await run_file_mutation(file_path, async () => {
            let committed = false;
            await update_file_state((current) => {
                const sheet = source?.meta().sheets[message.sheetIndex];
                if (
                    disposed
                    || !core
                    || expected_file_epoch !== current_file_epoch(file_path)
                    || source_file_epoch !== expected_file_epoch
                    || message.sourceGeneration !== core.source_generation
                    || !sheet
                    || (transform_has_entries(state)
                        && state.schema !== transform_schema_for_sheet(sheet))
                ) {
                    return current;
                }
                committed = true;
                const transforms = [...(current.transforms ?? [])];
                transforms[message.sheetIndex] = transform_has_entries(state)
                    ? {
                        ...state,
                        sort: state.sort.map((key) => ({ ...key })),
                        filters: state.filters.map((entry) => ({ ...entry })),
                    }
                    : undefined;
                return { ...current, transforms };
            });
            if (!committed) {
                throw new Error('The source changed before this sort/filter could be saved.');
            }
        });
    }

    async function build_source(): Promise<{
        source: DataSource;
        digest: string;
        snapshot: string;
    }> {
        const state = state_store.get(file_path) as PerFileState;
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

    async function prepare_source_for_adoption(
        ds: DataSource,
        seq: number,
        snapshot: string,
        digest: string,
    ): Promise<boolean> {
        if (!(ds instanceof ExcelHeaderDataSource)) {
            return built_source_is_current(seq, snapshot, digest);
        }
        const sheet_names = ds.meta().sheets.map((sheet) => sheet.name);
        const decision = await transact_file_state(async (current) => {
            // Rebase the candidate and derive migration from the exact state held
            // by this conditional transaction, not from its parse-time snapshot.
            ds.replace_overrides(current.excelFirstRowHeaders);
            const sheets = ds.meta().sheets;
            const previous_active = sanitize_excel_header_active(
                current.excelFirstRowHeaderActive,
            );
            const next_active = Object.create(null) as Record<string, boolean>;
            const changed_indices = new Set<number>();
            sheets.forEach((sheet, index) => {
                const active = sheet.excelFirstRowHeader?.active ?? false;
                next_active[sheet.name] = active;
                if (current.excelFirstRowHeaderVersion !== 1) {
                    if (active) changed_indices.add(index);
                } else if (
                    !Object.prototype.hasOwnProperty.call(previous_active, sheet.name)
                        ? active
                        : previous_active[sheet.name] !== active
                ) {
                    changed_indices.add(index);
                }
            });
            // This is the adoption transaction's linearization point. A rejection
            // here performs no durable state write; a later file change belongs to
            // the next watcher revision and does not retroactively abort this one.
            if (!await built_source_is_current(seq, snapshot, digest)) {
                return { type: 'abort' };
            }
            if (
                current.excelFirstRowHeaderVersion === 1
                && excel_header_maps_equal(previous_active, next_active)
            ) {
                return { type: 'accept' };
            }
            const rowHeights = [...(current.rowHeights ?? [])];
            const scrollPosition = [...(current.scrollPosition ?? [])];
            let transforms = current.transforms;
            let columnVisibility = current.columnVisibility;
            for (const index of changed_indices) {
                rowHeights[index] = undefined;
                scrollPosition[index] = undefined;
                if (current.excelFirstRowHeaderVersion !== 1) {
                    const sheet = sheets[index];
                    if (!sheet) continue;
                    const physical_schema = JSON.stringify([
                        sheet.name,
                        sheet.columnCount,
                        null,
                    ]);
                    const projected_schema = transform_schema_for_sheet(sheet);
                    transforms = migrate_sheet_schema(
                        transforms,
                        index,
                        physical_schema,
                        projected_schema,
                    );
                    columnVisibility = migrate_sheet_schema(
                        columnVisibility,
                        index,
                        physical_schema,
                        projected_schema,
                    );
                }
            }
            return {
                type: 'commit',
                state: {
                    ...current,
                    rowHeights,
                    scrollPosition,
                    transforms,
                    columnVisibility,
                    excelFirstRowHeaderActive: next_active,
                    excelFirstRowHeaderVersion: 1,
                },
            };
        }, sheet_names);
        return decision !== 'abort';
    }

    function prepare_built_source_for_adoption(
        ds: DataSource,
        seq: number,
        snapshot: string,
        digest: string,
    ): Promise<boolean> {
        return prepare_source_for_adoption(ds, seq, snapshot, digest);
    }

    function adopt(
        ds: DataSource,
        digest: string,
        file_epoch: number,
    ): boolean {
        // Snapshot/state linearization may legitimately complete after a newer file
        // event, but panel disposal is an absolute lifecycle boundary. Refuse the
        // fresh candidate before installing a core/source and own its single close.
        if (disposed) {
            ds.close();
            return false;
        }
        core = adopt_source_into_core(core, panel, source, ds, {
            onTransformCommit: persist_transform_commit,
        });
        source = ds;
        source_file_epoch = file_epoch;
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
            && source_file_epoch === delivered_file_epoch
            && source_file_epoch === current_file_epoch(file_path)
            && core.generation === delivered_generation
            && core.source_generation === delivered_source_generation;
    }

    function mark_metadata_delivered(seq?: number): void {
        delivered_digest = adopted_digest;
        delivered_file_epoch = source_file_epoch;
        delivered_generation = core?.generation;
        delivered_source_generation = core?.source_generation;
        // A direct header projection delivery is not completion of an unrelated
        // physical-file reload episode. Only that episode's own successful post
        // may clear its retry timer and budget.
        if (seq !== undefined && seq === reload_seq) reset_reload_retry();
    }

    function state_for_reload(ds: DataSource): PerFileState {
        return normalize_per_file_state(
            state_store.get(file_path),
            ds.meta().sheets.map((sheet) => sheet.name),
        );
    }

    function state_for_first_meta(): PerFileState {
        const state = state_store.get(file_path) as PerFileState;
        if (!profile.editing || !state.pendingEdits) return state;
        if (try_claim_edit_session()) return state;
        const { pendingEdits: _drop, ...rest } = state;
        return rest;
    }

    async function send_first_meta(ds: DataSource): Promise<boolean> {
        const settlement = outstanding_header_settlement;
        const delivered = await core!.send_meta({
            state: state_for_first_meta(),
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
            state: settlement ? state_for_reload(ds) : state,
        });
        if (delivered && settlement === outstanding_header_settlement) {
            outstanding_header_settlement = undefined;
        }
        return delivered;
    }

    async function post_header_projection(
        ds: DataSource,
        request_id: string,
    ): Promise<boolean> {
        if (!initial_meta_sent) {
            const delivered = await send_first_meta(ds);
            if (delivered && ready_seen) initial_meta_sent = true;
            return delivered;
        }
        return post_reload(
            ds,
            'excelHeader',
            request_id,
            state_for_reload(ds),
        );
    }

    async function apply_excel_header_override(
        sheet_name: string,
        override: ExcelHeaderOverride,
        previous_file_epoch: number,
        file_epoch: number,
        request_id: string,
        is_origin: boolean,
    ): Promise<boolean> {
        if (disposed) return false;
        const settlement = publish_header_settlement(
            request_id,
            file_epoch,
            is_origin,
        );
        if (source_file_epoch !== previous_file_epoch) {
            if (!is_origin) void send_header_recovery(settlement);
            return false;
        }
        if (
            !core
            || !(source instanceof ExcelHeaderDataSource)
            || !source.set_override(sheet_name, override)
        ) {
            return false;
        }
        // The projected source object is intentionally reused. set_source still
        // invalidates source generations, transforms, and row-window caches.
        core.set_source(source);
        source_file_epoch = file_epoch;
        const attempts = is_origin ? HEADER_RELOAD_RETRY_COUNT : 1;
        for (let attempt = 0; attempt < attempts; attempt++) {
            if (disposed || source_file_epoch !== file_epoch) return false;
            try {
                if (await post_header_projection(source, request_id)) {
                    mark_metadata_delivered();
                    return true;
                }
            } catch {
                // A rejected post is the same delivery failure as `false` here.
                // Secondary tabs must fall through to correlated physical-source
                // recovery after their source generations have already advanced.
            }
            if (attempt + 1 < attempts) await delay(HEADER_RELOAD_RETRY_MS);
        }
        if (!is_origin && !disposed) void send_header_recovery(settlement);
        return false;
    }

    disposables.push(subscribe_excel_headers(file_path, {
        token: excel_header_subscriber_token,
        refresh: apply_excel_header_override,
    }));

    function surface_warnings(ds: DataSource): void {
        const warnings = ds.warnings ?? [];
        if (warnings.length > 0) vscode.window.showWarningMessage(warnings[0]);
    }

    // Drop any cached pendingEdits for this file, keeping the rest of the state.
    function clear_pending_edits(): Promise<void> {
        return update_file_state((current) => {
            const { pendingEdits: _drop, ...rest } = current;
            return rest;
        });
    }

    async function send_initial_data(): Promise<void> {
        reset_reload_retry();
        const seq = ++reload_seq;
        let candidate: DataSource | undefined;
        try {
            const { source: ds, digest, snapshot } = await build_source();
            candidate = ds;
            await run_file_mutation(file_path, async () => {
                if (!await prepare_built_source_for_adoption(ds, seq, snapshot, digest)) {
                    discard_stale_built_source(ds, seq, true);
                    return;
                }
                if (!adopt(ds, digest, establish_file_revision(file_path, digest))) {
                    return;
                }
                if (await send_first_meta(ds)) {
                    initial_meta_sent = true;
                    mark_metadata_delivered(seq);
                    surface_warnings(ds);
                } else {
                    schedule_reload_retry(true, seq);
                }
            });
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
            await run_file_mutation(file_path, async () => {
                if (!await prepare_built_source_for_adoption(ds, seq, snapshot, digest)) {
                    discard_stale_built_source(ds, seq, true);
                    return;
                }
                if (!adopt(ds, digest, establish_file_revision(file_path, digest))) {
                    return;
                }
                try {
                    delivered = await post_reload(ds);
                } catch (error) {
                    if (!schedule_reload_retry(true, seq)) throw error;
                    return;
                }
                if (delivered) {
                    mark_metadata_delivered(seq);
                } else {
                    schedule_reload_retry(true, seq);
                }
            });
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
            const { source: ds, digest, snapshot } = await build_source();
            candidate = ds;
            await run_file_mutation(file_path, async () => {
                if (
                    header_recovery
                    && outstanding_header_settlement !== header_recovery.settlement
                ) {
                    ds.close();
                    delivered = true;
                    return;
                }
                if (!await built_source_is_current(seq, snapshot, digest)) {
                    discard_stale_built_source(
                        ds,
                        seq,
                        force,
                        header_recovery,
                    );
                    return;
                }
                // Deduplicate only when the webview has actually received metadata
                // for the currently adopted source and both core generations.
                if (
                    !force
                    && outstanding_header_settlement === undefined
                    && digest === delivered_digest
                    && metadata_is_delivered()
                ) {
                    ds.close();
                    mark_metadata_delivered(seq);
                    delivered = true;
                    return;
                }
                if (
                    ds instanceof ExcelHeaderDataSource
                    && !await prepare_source_for_adoption(ds, seq, snapshot, digest)
                ) {
                    discard_stale_built_source(
                        ds,
                        seq,
                        force,
                        header_recovery,
                    );
                    return;
                }
                if (
                    header_recovery
                    && outstanding_header_settlement !== header_recovery.settlement
                ) {
                    ds.close();
                    delivered = true;
                    return;
                }
                if (!adopt(ds, digest, establish_file_revision(file_path, digest))) {
                    return;
                }
                if (!initial_meta_sent) {
                    delivered = await send_first_meta(ds);
                    if (!delivered) {
                        if (!header_recovery) schedule_reload_retry(force, seq);
                        return;
                    }
                    if (ready_seen) initial_meta_sent = true;
                    mark_metadata_delivered(header_recovery ? undefined : seq);
                    surface_warnings(ds);
                    return;
                }
                delivered = await post_reload(
                    ds,
                    header_recovery ? 'excelHeader' : undefined,
                    header_recovery?.requestId,
                    header_recovery ? state_for_reload(ds) : undefined,
                );
                if (!delivered) {
                    if (!header_recovery) schedule_reload_retry(force, seq);
                    return;
                }
                mark_metadata_delivered(header_recovery ? undefined : seq);
                surface_warnings(ds);
            });
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
            let obsolete = false;
            let delivered_settlement: typeof tracked_settlement | undefined;
            await run_file_mutation(file_path, async () => {
                if (outstanding_header_settlement !== tracked_settlement) {
                    obsolete = true;
                    return;
                }
                if (
                    disposed
                    || !core
                    || !source
                    || source_file_epoch !== current_file_epoch(file_path)
                ) return;
                try {
                    if (!initial_meta_sent) {
                        delivered = await send_first_meta(source);
                        if (delivered && ready_seen) initial_meta_sent = true;
                    } else {
                        delivered = await core.send_meta_recovery({
                            state: state_for_reload(source),
                            ...editing_flags(source),
                            headerRequestId: tracked_settlement.requestId,
                            error: tracked_settlement.error,
                        });
                    }
                } catch {
                    return;
                }
                if (!delivered) return;
                delivered_settlement = tracked_settlement;
                mark_metadata_delivered();
                surface_warnings(source);
            });
            if (obsolete) return true;
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
                const expected_file_epoch = source_file_epoch;
                await run_file_mutation(file_path, async () => {
                    await update_file_state((current) => {
                        if (
                            disposed
                            || !core
                            || expected_file_epoch !== current_file_epoch(file_path)
                            || source_file_epoch !== expected_file_epoch
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
                    });
                });
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
                let failure: string | undefined;
                let refresh_failed = false;
                let committed_settlement: HeaderSettlement | undefined;
                try {
                    await run_file_mutation(file_path, async () => {
                        if (
                            disposed
                            || !(source instanceof ExcelHeaderDataSource)
                            || !core
                        ) {
                            failure = 'First-row headers are only available for Excel worksheets.';
                            return;
                        }
                        if (
                            source_file_epoch !== current_file_epoch(file_path)
                            || msg.generation !== core.generation
                            || msg.sourceGeneration !== core.source_generation
                        ) {
                            failure = 'The worksheet changed before the header request arrived.';
                            return;
                        }
                        const sheet = source.meta().sheets[msg.sheetIndex];
                        if (!sheet || sheet.name !== msg.sheetName) {
                            failure = 'The selected worksheet no longer matches this request.';
                            return;
                        }
                        const header = sheet.excelFirstRowHeader;
                        if (!header) {
                            failure = 'First-row headers are only available for Excel worksheets.';
                            return;
                        }
                        if (msg.enabled && !header.available) {
                            failure = 'This worksheet has no first row to use as column names.';
                            return;
                        }
                        const override: ExcelHeaderOverride = msg.enabled ? 'on' : 'off';
                        // Sorting and filtering survive a header toggle: the sheet's
                        // columns keep their indices (only row 0 moves in or out of the
                        // body), so persisted descriptors stay valid once their schema
                        // fingerprint is migrated to the projected sheet's new one.
                        const previous_mode = header.mode;
                        const old_schema = transform_schema_for_sheet(sheet);
                        source.set_override(msg.sheetName, override);
                        const projected = source.meta().sheets[msg.sheetIndex];
                        const new_schema = projected
                            ? transform_schema_for_sheet(projected)
                            : undefined;
                        source.set_override(msg.sheetName, previous_mode);
                        await update_file_state((current) => {
                            const excelFirstRowHeaders = sanitize_excel_header_overrides(
                                current.excelFirstRowHeaders,
                            );
                            excelFirstRowHeaders[msg.sheetName] = override;
                            const excelFirstRowHeaderActive = sanitize_excel_header_active(
                                current.excelFirstRowHeaderActive,
                            );
                            excelFirstRowHeaderActive[msg.sheetName] = msg.enabled;
                            const rowHeights = [...(current.rowHeights ?? [])];
                            const scrollPosition = [...(current.scrollPosition ?? [])];
                            rowHeights[msg.sheetIndex] = undefined;
                            scrollPosition[msg.sheetIndex] = undefined;
                            const transforms = migrate_sheet_schema(
                                current.transforms,
                                msg.sheetIndex,
                                old_schema,
                                new_schema,
                            );
                            const columnVisibility = migrate_sheet_schema(
                                current.columnVisibility,
                                msg.sheetIndex,
                                old_schema,
                                new_schema,
                            );
                            return {
                                ...current,
                                excelFirstRowHeaders,
                                excelFirstRowHeaderActive,
                                excelFirstRowHeaderVersion: 1,
                                rowHeights,
                                scrollPosition,
                                transforms,
                                columnVisibility,
                            };
                        });
                        const previous_file_epoch = current_file_epoch(file_path);
                        const file_epoch = advance_file_epoch(file_path);
                        committed_settlement = publish_header_settlement(
                            msg.requestId,
                            file_epoch,
                            true,
                        );
                        const origin_delivered = await broadcast_excel_header(
                            file_path,
                            msg.sheetName,
                            override,
                            previous_file_epoch,
                            file_epoch,
                            msg.requestId,
                            excel_header_subscriber_token,
                        );
                        if (!origin_delivered && !disposed) {
                            refresh_failed = true;
                            failure = 'The header setting was saved, but the view could not refresh.';
                        }
                    });
                } catch (error) {
                    failure = error instanceof Error ? error.message : String(error);
                }
                if (refresh_failed && !disposed && committed_settlement) {
                    const recovered = await send_header_recovery(
                        committed_settlement,
                        failure,
                    );
                    if (recovered) failure = undefined;
                    else return;
                }
                if (failure) await fail(failure);
                return;
            }
            case 'setColumnVisibility': {
                const expected_file_epoch = source_file_epoch;
                await run_file_mutation(file_path, async () => {
                    await update_file_state((current) => {
                        if (
                            !source
                            || !core
                            || expected_file_epoch !== current_file_epoch(file_path)
                            || source_file_epoch !== expected_file_epoch
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
                    });
                });
                return;
            }
            case 'requestEditSession': {
                const can_edit = profile.editing
                    && !!source
                    && !source.truncationMessage
                    && !(core?.has_transform_work ?? false);
                const owner = active_csv_edit_sessions.get(file_path);
                const denied_by_owner = can_edit
                    && owner !== undefined
                    && owner !== edit_session_token;
                const denied_by_transform = profile.editing
                    && !!source
                    && !source.truncationMessage
                    && (core?.has_transform_work ?? false);
                const granted = can_edit && !denied_by_owner && try_claim_edit_session();
                const pendingEdits = granted
                    ? (state_store.get(file_path) as PerFileState).pendingEdits
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
                transform_file_epochs.set(msg.requestId, source_file_epoch);
                try {
                    await core?.handle_message(msg);
                } finally {
                    transform_file_epochs.delete(msg.requestId);
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
            release_file_mutation_context(file_path, mutation_context);
        },
    };
}
