import * as vscode from 'vscode';
import {
    register_table_viewer,
    TABLE_VIEW_TYPE,
    type TableViewerIntegrationSession,
    type TableViewerRegistration,
} from './custom-editor';
import {
    show_csv_preview,
    dispose_csv_preview,
    drain_csv_previews,
} from './csv-preview';
import {
    open_vscode_state_database,
    type OpenedVscodeStateDatabase,
} from './vscode-state-database';
import { DEFAULT_MAX_STORED_FILES } from './state';
import {
    table_diff_document_uris,
    table_diff_uris,
    table_diff_working_tree_uri,
    type TableDiffUris,
} from './table-diff-uris';
import {
    dispose_state_inspector_panel,
    show_state_inspector_panel,
} from './state-inspector/vscode-panel';

interface ActiveExtensionRuntime {
    readonly viewers: TableViewerRegistration;
    readonly disposables: vscode.Disposable[];
    readonly database: OpenedVscodeStateDatabase;
}

interface OpenWorkbookAtSheetArguments {
    readonly uri: string;
    readonly sheetName: string;
}

export interface TableViewerExtensionTestApi {
    integrationSession(uri: vscode.Uri): TableViewerIntegrationSession | undefined;
}

function open_workbook_at_sheet_arguments(value: unknown): OpenWorkbookAtSheetArguments {
    if (
        typeof value !== 'object'
        || value === null
        || !('uri' in value)
        || typeof value.uri !== 'string'
        || value.uri.length === 0
        || !('sheetName' in value)
        || typeof value.sheetName !== 'string'
        || value.sheetName.length === 0
    ) {
        throw new TypeError(
            'tableViewer.openWorkbookAtSheet requires { uri: string, sheetName: string }.',
        );
    }
    return { uri: value.uri, sheetName: value.sheetName };
}

/** The resourceUri of an SCM resource-state command argument, if that is what
 *  `value` is. The SCM menus pass a SourceControlResourceState; anything else
 *  (palette invocation, stray argument) yields undefined. */
function is_file_not_found_error(error: unknown): boolean {
    return typeof error === 'object' && error !== null
        && 'code' in error
        && (error as { code?: unknown }).code === 'FileNotFound';
}

function scm_resource_uri(value: unknown): vscode.Uri | undefined {
    if (typeof value !== 'object' || value === null) return undefined;
    const candidate = (value as { resourceUri?: unknown }).resourceUri;
    // Duck-typed rather than instanceof: the SCM state's URI may come from a
    // different extension-host realm than this module's vscode import.
    return typeof candidate === 'object' && candidate !== null
        && typeof (candidate as vscode.Uri).scheme === 'string'
        && typeof (candidate as vscode.Uri).with === 'function'
        ? candidate as vscode.Uri
        : undefined;
}

/**
 * The git extension's URI for `uri` at `ref`. Prefer the git extension's own
 * `toGitUri` (it owns the encoding); fall back to the same construction
 * (scheme `git`, JSON query with `{path, ref}`) when the API is unavailable.
 */
function to_git_uri(uri: vscode.Uri, ref: string): vscode.Uri {
    try {
        const git = vscode.extensions.getExtension<{
            getAPI(version: 1): { toGitUri(target: vscode.Uri, ref: string): vscode.Uri };
        }>('vscode.git')?.exports;
        const from_api = git?.getAPI(1).toGitUri(uri, ref);
        if (from_api) return from_api;
    } catch {
        // The git extension may be disabled or not yet activated; the manual
        // construction below matches its current encoding.
    }
    return uri.with({
        scheme: 'git',
        query: JSON.stringify({ path: uri.fsPath, ref }),
    });
}

let active_runtime: ActiveExtensionRuntime | undefined;
let active_teardown: Promise<void> | undefined;

function active_custom_tab_uri(): vscode.Uri | undefined {
    const input = vscode.window.tabGroups.activeTabGroup.activeTab?.input;
    return input instanceof vscode.TabInputCustom ? input.uri : undefined;
}

function active_custom_source_uri(): vscode.Uri | undefined {
    const uri = active_custom_tab_uri();
    if (!uri) return undefined;
    const diff = table_diff_document_uris(uri);
    return diff ? table_diff_working_tree_uri(diff) : uri;
}

function extension_version(context: vscode.ExtensionContext): string {
    const version = (context.extension?.packageJSON as { version?: unknown } | undefined)?.version;
    return typeof version === 'string' && version.length > 0 ? version : '0.0.0';
}

const MAX_STORED_FILES_CEILING = 100_000;

function get_max_stored_files(): number {
    // The setting is user-editable, so a hand-written settings file can supply a
    // non-integer, a negative, or a value large enough to disable retention
    // entirely. Clamp at the boundary rather than trusting the manifest schema.
    const configured = vscode.workspace.getConfiguration('tableViewer')
        .get<number>('maxStoredFiles', DEFAULT_MAX_STORED_FILES);
    if (typeof configured !== 'number' || !Number.isFinite(configured)) {
        return DEFAULT_MAX_STORED_FILES;
    }
    return Math.min(MAX_STORED_FILES_CEILING, Math.max(1, Math.floor(configured)));
}

function dispose_best_effort(disposable: vscode.Disposable | undefined): void {
    try {
        disposable?.dispose();
    } catch {
        // Teardown continues so persistence queues can still be drained.
    }
}

export async function activate(
    context: vscode.ExtensionContext,
): Promise<TableViewerExtensionTestApi | undefined> {
    const state_directory = vscode.Uri.joinPath(context.globalStorageUri, 'state');
    try {
        await vscode.workspace.fs.createDirectory(state_directory);
    } catch {
        // The open below is authoritative and reports an unusable directory with
        // the path and cause; a failure here would say strictly less.
    }
    let database: OpenedVscodeStateDatabase;
    try {
        database = await open_vscode_state_database({
            storageDirectory: state_directory.fsPath,
            appVersion: extension_version(context),
            getMaxStoredFiles: get_max_stored_files,
        });
    } catch (error) {
        // SQLite is the only backend. Fail activation loudly rather than run with
        // state the user cannot see the loss of, and leave the file untouched so
        // moving it aside stays their decision.
        const message = error instanceof Error ? error.message : String(error);
        void vscode.window.showErrorMessage(message);
        throw error;
    }

    let viewers: TableViewerRegistration | undefined;
    let replace_native_diff: ((tab: vscode.Tab, diff: TableDiffUris) => void) | undefined;
    const pending_native_diffs: Array<{ readonly tab: vscode.Tab; readonly diff: TableDiffUris }> = [];
    const disposables: vscode.Disposable[] = [];
    try {
        const extension_test_mode = vscode.ExtensionMode?.Test;
        viewers = register_table_viewer(context, database.store, {
            integrationTests: extension_test_mode !== undefined
                && context.extensionMode === extension_test_mode,
            replaceNativeDiff: (tab, diff) => {
                if (replace_native_diff) replace_native_diff(tab, diff);
                else pending_native_diffs.push({ tab, diff });
            },
        });
        disposables.push({ dispose: dispose_csv_preview });
        disposables.push({ dispose: dispose_state_inspector_panel });
        // Each registration is pushed as soon as it exists. A single
        // push(a, b, c) evaluates every argument before the array is touched, so
        // a failure registering the second command would leak the first past the
        // rollback below.
        const register = (command: string, handler: (...args: any[]) => unknown): void => {
            disposables.push(vscode.commands.registerCommand(command, handler));
        };
        const preview_in = (column: number) => (uri?: vscode.Uri) => {
            const target = uri ?? vscode.window.activeTextEditor?.document.uri;
            if (!target) return;
            show_csv_preview(target, context.extensionUri, database.store, column);
        };
        const open_with = (view_type: string, fallback: () => vscode.Uri | undefined) => (
            (uri?: vscode.Uri) => {
                const target = uri ?? fallback();
                if (!target) return;
                void vscode.commands.executeCommand('vscode.openWith', target, view_type);
            }
        );
        register('tableViewer.showCsvPreviewToSide', preview_in(vscode.ViewColumn.Beside));
        register('tableViewer.showCsvPreview', preview_in(vscode.ViewColumn.Active));
        register('tableViewer.openCsvTable', open_with(
            TABLE_VIEW_TYPE,
            () => vscode.window.activeTextEditor?.document.uri,
        ));
        register('tableViewer.openAsText', open_with('default', active_custom_source_uri));
        // Command failures surface as an error message but stay thrown, so
        // callers (tests, other extensions) still observe the rejection.
        const reporting_errors = async <T>(action: () => Promise<T>): Promise<T> => {
            try {
                return await action();
            } catch (error) {
                const message = error instanceof Error ? error.message : String(error);
                void vscode.window.showErrorMessage(message);
                throw error;
            }
        };
        register('tableViewer.openWorkingTreeFile', async (uri?: vscode.Uri) => {
            const target = uri ?? active_custom_tab_uri();
            const diff = target ? table_diff_document_uris(target) : undefined;
            if (!diff) return;
            await reporting_errors(async () => {
                await viewers!.openWorkingTreeFile(table_diff_working_tree_uri(diff));
            });
        });
        const replacing_diff_tabs = new WeakSet<vscode.Tab>();
        const tab_group_for = (tab: vscode.Tab): vscode.TabGroup | undefined => (
            vscode.window.tabGroups.all.find((group) => group.tabs.includes(tab))
        );
        const replace_table_diff = (
            tab: vscode.Tab,
            resolved_diff?: TableDiffUris,
        ): void => {
            if (replacing_diff_tabs.has(tab)) return;
            const input = tab.input;
            const diff = resolved_diff ?? (
                input instanceof vscode.TabInputTextDiff
                    ? table_diff_uris(input.original, input.modified)
                    : undefined
            );
            const group = tab_group_for(tab);
            if (!diff || !group) return;
            const view_column = group.viewColumn;
            replacing_diff_tabs.add(tab);
            void reporting_errors(async () => {
                try {
                    // Open or reveal the replacement first. If that fails, the
                    // working native diff remains intact and can be retried.
                    await viewers!.openTableDiff(diff, view_column);
                    if (tab_group_for(tab)) {
                        await vscode.window.tabGroups.close(tab);
                    }
                } finally {
                    replacing_diff_tabs.delete(tab);
                }
            }).catch(() => {});
        };
        register('tableViewer.openWorkbookAtSheet', (value: unknown) => reporting_errors(
            async () => {
                const args = open_workbook_at_sheet_arguments(value);
                const uri = vscode.Uri.parse(args.uri, true);
                const found = await viewers!.openWorkbookAtSheet(uri, args.sheetName);
                if (!found) {
                    void vscode.window.showWarningMessage(
                        `Worksheet "${args.sheetName}" was not found.`,
                    );
                }
                return found;
            },
        ));
        register('tableViewer.openTableDiff', async (resource_state?: unknown) => {
            const uri = scm_resource_uri(resource_state)
                ?? vscode.window.activeTextEditor?.document.uri;
            if (!uri || uri.scheme !== 'file') return;
            await reporting_errors(async () => {
                // A deleted resource has no working-tree side to open; the
                // viewer's primary document must exist. Say so instead of
                // surfacing the raw stat failure from the open.
                try {
                    await vscode.workspace.fs.stat(uri);
                } catch (error) {
                    if (!is_file_not_found_error(error)) throw error;
                    throw new Error(
                        'The file no longer exists in the working tree, so there is '
                        + 'nothing to compare. Restore or check out the file to view it.',
                    );
                }
                await viewers!.openTableDiff({
                    modified: uri,
                    original: to_git_uri(uri, '~'),
                });
            });
        });
        register('tableViewer.openStagedTableDiff', async (resource_state?: unknown) => {
            const uri = scm_resource_uri(resource_state)
                ?? vscode.window.activeTextEditor?.document.uri;
            if (!uri || uri.scheme !== 'file') return;
            await reporting_errors(async () => {
                await viewers!.openTableDiff({
                    modified: to_git_uri(uri, ''),
                    original: to_git_uri(uri, 'HEAD'),
                });
            });
        });
        register('tableViewer.manageStoredFileState', () => {
            show_state_inspector_panel({
                extensionUri: context.extensionUri,
                maintenance: database.maintenance,
                databasePath: database.databasePath,
            });
        });
        disposables.push(vscode.window.tabGroups.onDidChangeTabs((event) => {
            for (const tab of new Set([...event.opened, ...event.changed])) {
                replace_table_diff(tab);
            }
        }));
        context.subscriptions.push(...disposables);
        replace_native_diff = replace_table_diff;
        for (const { tab, diff } of pending_native_diffs.splice(0)) {
            replace_table_diff(tab, diff);
        }
        // Activation can race the native diff opening that caused it. Inspect the
        // current tabs as well as future events so that first click is not missed.
        for (const group of vscode.window.tabGroups.all) {
            for (const tab of group.tabs) replace_table_diff(tab);
        }
        active_runtime = { viewers, disposables, database };
        return extension_test_mode !== undefined
            && context.extensionMode === extension_test_mode
            ? { integrationSession: (uri) => viewers!.integrationSession(uri) }
            : undefined;
    } catch (error) {
        // Nothing may keep the database open after a failed activation: VS Code
        // will not call deactivate for an activation that threw, and a retained
        // handle would block the coordination gate for the next attempt.
        for (const disposable of [...disposables].reverse()) dispose_best_effort(disposable);
        if (viewers) dispose_best_effort(viewers);
        const drains: Promise<void>[] = [];
        if (viewers) drains.push(viewers.drain());
        drains.push(drain_csv_previews());
        await Promise.allSettled(drains);
        try {
            await database.close();
        } catch {
            // Preserve the activation failure that triggered this rollback.
        }
        throw error;
    }
}

async function drain_runtime(runtime: ActiveExtensionRuntime): Promise<void> {
    let viewer_failure: { error: unknown } | undefined;
    try {
        await runtime.viewers.drain();
    } catch (error) {
        viewer_failure = { error };
    }
    try {
        await drain_csv_previews();
    } catch (preview_failure) {
        if (viewer_failure) {
            throw new AggregateError(
                [viewer_failure.error, preview_failure],
                'Viewer and CSV preview drains failed during deactivation.',
            );
        }
        throw preview_failure;
    }
    if (viewer_failure) throw viewer_failure.error;
}

export function deactivate(): Promise<void> {
    if (active_teardown) return active_teardown;
    const runtime = active_runtime;
    if (!runtime) return Promise.resolve();
    const teardown = (async () => {
        // Dispose first so no new panel or preview work can begin, then let the
        // already-admitted controller writes settle, and only then close SQLite.
        // dispose_viewers() fences edit admission before its first await, so the
        // drains below observe closed sets. A failed viewer or preview drain retains
        // the runtime and database so a later deactivation can retry the flush.
        for (const disposable of runtime.disposables) dispose_best_effort(disposable);
        dispose_best_effort(runtime.viewers);
        await drain_runtime(runtime);
        await runtime.database.close();
        if (active_runtime === runtime) active_runtime = undefined;
    })();
    active_teardown = teardown;
    void teardown.finally(() => {
        if (active_teardown === teardown) active_teardown = undefined;
    }).catch(() => {});
    return teardown;
}
