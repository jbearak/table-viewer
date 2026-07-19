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
import type { FileStateStore } from './state';
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

type ExcelHeaderSubscriber = (
    sheet_name: string,
    override: ExcelHeaderOverride,
) => Promise<void>;
const excel_header_subscribers = new Map<string, Set<ExcelHeaderSubscriber>>();

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
): Promise<void> {
    const subscribers = [...(excel_header_subscribers.get(file_path) ?? [])];
    await Promise.all(subscribers.map(async (subscriber) => {
        try {
            await subscriber(sheet_name, override);
        } catch (error) {
            console.error('Failed to refresh an Excel header view', error);
        }
    }));
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

    let core: ViewerPanelCore | undefined;
    let source: DataSource | undefined;
    let reload_seq = 0;
    let disposed = false;
    let initial_meta_sent = false;
    let ready_seen = false;
    let last_mtime = 0;
    let consecutive_reload_failures = 0;
    const edit_session_token = Symbol(file_path);

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

    async function update_file_state(
        updater: (current: PerFileState) => PerFileState,
        sheet_names = source?.meta().sheets.map((sheet) => sheet.name) ?? [],
    ): Promise<void> {
        const normalize_host_state = (stored: StoredPerFileState): PerFileState => {
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
        };
        if (state_store.update) {
            await state_store.update(
                file_path,
                (current) => updater(normalize_host_state(current)),
            );
            return;
        }
        await state_store.set(
            file_path,
            updater(normalize_host_state(state_store.get(file_path))),
        );
    }

    async function persist_transform_commit(
        message: Extract<WebviewMessage, { type: 'setTransform' }>,
        state: SheetTransformState,
    ): Promise<void> {
        // Restores merely recompute host-owned preferences. Only explicit user
        // actions can replace those preferences, and the core awaits this write
        // before posting its terminal acknowledgement.
        if (message.intent === 'restore') return;
        await update_file_state((current) => {
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
    }

    async function build_source(): Promise<{ source: DataSource; mtime: number }> {
        const state = state_store.get(file_path) as PerFileState;
        const stat = await vscode.workspace.fs.stat(uri);
        const max_mib = get_max_file_size_mib();
        assert_safe_file_size(stat.size, max_mib);
        const raw = await vscode.workspace.fs.readFile(uri);
        assert_safe_file_size(raw.byteLength, max_mib);
        const ds = await profile.build_source(raw, file_path, state);
        if (ds instanceof ExcelHeaderDataSource) {
            // A long parse can overlap a header change from another open tab. Apply
            // the latest durable overrides immediately before this source is adopted.
            const latest = state_store.get(file_path) as PerFileState;
            ds.replace_overrides(latest.excelFirstRowHeaders);
            const sheet_names = ds.meta().sheets.map((sheet) => sheet.name);
            const previous_active = sanitize_excel_header_active(
                latest.excelFirstRowHeaderActive,
            );
            const next_active = Object.create(null) as Record<string, boolean>;
            const changed_indices = new Set<number>();
            ds.meta().sheets.forEach((sheet, index) => {
                const active = sheet.excelFirstRowHeader?.active ?? false;
                next_active[sheet.name] = active;
                if (latest.excelFirstRowHeaderVersion !== 1) {
                    if (active) changed_indices.add(index);
                } else if (
                    !Object.prototype.hasOwnProperty.call(previous_active, sheet.name)
                        ? active
                        : previous_active[sheet.name] !== active
                ) {
                    changed_indices.add(index);
                }
            });
            if (
                latest.excelFirstRowHeaderVersion !== 1
                || !excel_header_maps_equal(previous_active, next_active)
            ) {
                await update_file_state((current) => {
                    const rowHeights = [...(current.rowHeights ?? [])];
                    const scrollPosition = [...(current.scrollPosition ?? [])];
                    for (const index of changed_indices) {
                        rowHeights[index] = undefined;
                        scrollPosition[index] = undefined;
                    }
                    return {
                        ...current,
                        rowHeights,
                        scrollPosition,
                        excelFirstRowHeaderActive: next_active,
                        excelFirstRowHeaderVersion: 1,
                    };
                }, sheet_names);
            }
        }
        return { source: ds, mtime: stat.mtime };
    }

    function adopt(ds: DataSource, mtime: number): void {
        core = adopt_source_into_core(core, panel, source, ds, {
            onTransformCommit: persist_transform_commit,
        });
        source = ds;
        last_mtime = mtime;
        profile.on_source_adopted?.(ds);
    }

    function state_for_first_meta(): PerFileState {
        const state = state_store.get(file_path) as PerFileState;
        if (!profile.editing || !state.pendingEdits) return state;
        if (try_claim_edit_session()) return state;
        const { pendingEdits: _drop, ...rest } = state;
        return rest;
    }

    function send_first_meta(ds: DataSource): Promise<void> {
        return core!.send_meta({
            state: state_for_first_meta(),
            defaultTabOrientation: get_default_orientation(),
            previewMode: profile.previewMode,
            ...editing_flags(ds),
        });
    }

    function post_reload(ds: DataSource): Promise<boolean> {
        return core!.send_meta_reload(editing_flags(ds));
    }

    async function apply_excel_header_override(
        sheet_name: string,
        override: ExcelHeaderOverride,
    ): Promise<void> {
        if (
            disposed
            || !core
            || !(source instanceof ExcelHeaderDataSource)
            || !source.set_override(sheet_name, override)
        ) {
            return;
        }
        // The projected source object is intentionally reused. set_source still
        // invalidates source generations, transforms, and row-window caches.
        core.set_source(source);
        await post_reload(source);
    }

    disposables.push(subscribe_excel_headers(file_path, apply_excel_header_override));

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
        const seq = ++reload_seq;
        try {
            const { source: ds, mtime } = await build_source();
            if (disposed || seq !== reload_seq) { ds.close(); return; }
            adopt(ds, mtime);
            await send_first_meta(ds);
            initial_meta_sent = true;
            surface_warnings(ds);
        } catch (err) {
            if (disposed) return;
            vscode.window.showErrorMessage(err instanceof Error ? err.message : String(err));
        }
    }

    // Re-parse on disk and adopt through the same monotonic guard send_reload
    // uses; bumping reload_seq invalidates any in-flight watcher reload.
    async function reparse_and_post(): Promise<void> {
        const seq = ++reload_seq;
        const { source: ds, mtime } = await build_source();
        if (!disposed && seq === reload_seq) {
            adopt(ds, mtime);
            await post_reload(ds);
        } else {
            ds.close();
        }
    }

    async function send_reload(): Promise<void> {
        if (disposed) return;
        const seq = ++reload_seq;
        try {
            const { source: ds, mtime } = await build_source();
            if (disposed || seq !== reload_seq) { ds.close(); return; }
            // Our own save's write fires the watcher; skip the redundant re-parse
            // when nothing changed. mtime-based so a genuine external edit (which
            // bumps mtime) still reloads. Only once we are showing data.
            if (initial_meta_sent && mtime === last_mtime) {
                ds.close();
                consecutive_reload_failures = 0;
                return;
            }
            adopt(ds, mtime);
            if (!initial_meta_sent) {
                await send_first_meta(ds);
                if (ready_seen) initial_meta_sent = true;
                consecutive_reload_failures = 0;
                return;
            }
            const delivered = await post_reload(ds);
            if (!delivered) return;
            consecutive_reload_failures = 0;
            surface_warnings(ds);
        } catch (err) {
            if (disposed) return;
            const code = typeof err === 'object' && err !== null && 'code' in err
                && typeof err.code === 'string' ? err.code : null;
            if (code === 'EBUSY' || code === 'EPERM') return;
            consecutive_reload_failures++;
            if (consecutive_reload_failures >= 3) {
                console.error('Failed to reload table viewer data', err);
                vscode.window.showErrorMessage(
                    `Failed to reload: ${err instanceof Error ? err.message : String(err)}`);
            }
        }
    }

    async function handle_save(edits: Record<string, string>): Promise<void> {
        if (!source) return;
        if (source.truncationMessage) {
            panel.webview.postMessage({ type: 'saveResult', success: false });
            return;
        }
        try {
            const current_stat = await vscode.workspace.fs.stat(uri);
            if (current_stat.mtime !== last_mtime) {
                vscode.window.showWarningMessage(
                    'File was modified externally. Please review the changes and try again.');
                // The save is correctly refused (conflict). A failure to re-parse
                // the externally-changed file must not turn this into a generic
                // "Failed to save" error on top of the conflict warning — report
                // the conflict result and return regardless of reload outcome.
                try {
                    await reparse_and_post();
                } catch (reload_err) {
                    console.error('Post-conflict reload failed', reload_err);
                }
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
            await vscode.workspace.fs.writeFile(uri, new TextEncoder().encode(content));
            // The write succeeded — the save is done. A failure to re-parse the
            // just-written file (a transient read error, or an external delete in
            // the TOCTOU window) must not be reported as a failed save: the bytes
            // are on disk. last_mtime is only advanced by a successful reparse, so
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
                await update_file_state((current) => {
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
                if (!(source instanceof ExcelHeaderDataSource) || !core) {
                    await fail('First-row headers are only available for Excel worksheets.');
                    return;
                }
                if (
                    msg.generation !== core.generation
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
                if (!sheet.excelFirstRowHeader?.available) {
                    await fail('This worksheet has no first row to use as column names.');
                    return;
                }
                if (core.has_transform_work) {
                    await fail('Clear sorting and filters before changing the header row.');
                    return;
                }

                const override: ExcelHeaderOverride = msg.enabled ? 'on' : 'off';
                try {
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
                        return {
                            ...current,
                            excelFirstRowHeaders,
                            excelFirstRowHeaderActive,
                            excelFirstRowHeaderVersion: 1,
                            rowHeights,
                            scrollPosition,
                        };
                    });
                    await broadcast_excel_header(file_path, msg.sheetName, override);
                } catch (error) {
                    await fail(error instanceof Error ? error.message : String(error));
                }
                return;
            }
            case 'setColumnVisibility': {
                await update_file_state((current) => {
                    if (!source) return current;
                    const sheet = source.meta().sheets[msg.sheetIndex];
                    if (!sheet) return current;
                    const columnVisibility = [...(current.columnVisibility ?? [])];
                    columnVisibility[msg.sheetIndex] = sanitize_column_visibility_state(
                        msg.state,
                        sheet.columnCount,
                        transform_schema_for_sheet(sheet),
                    );
                    return { ...current, columnVisibility };
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
                await core?.handle_message(msg);
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
            disposed = true;
            reload_seq++;
            release_edit_session();
            core?.dispose();
            source?.close();
            for (const d of disposables) d.dispose();
        },
    };
}
