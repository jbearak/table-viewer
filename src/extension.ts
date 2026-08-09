import * as vscode from 'vscode';
import {
    register_table_viewer,
    TABLE_VIEW_TYPE,
    type TableViewerRegistration,
} from './custom-editor';
import { show_csv_preview, dispose_csv_preview } from './csv-preview';
import {
    open_vscode_state_database,
    type OpenedVscodeStateDatabase,
} from './vscode-state-database';
import {
    create_file_state_store,
    DEFAULT_MAX_STORED_FILES,
    drain_keyed_state_runtime,
} from './state';

interface ActiveExtensionRuntime {
    readonly viewers: TableViewerRegistration;
    readonly disposables: vscode.Disposable[];
    readonly database: OpenedVscodeStateDatabase;
}

let active_runtime: ActiveExtensionRuntime | undefined;
let active_teardown: Promise<void> | undefined;

function active_custom_tab_uri(): vscode.Uri | undefined {
    const input = vscode.window.tabGroups.activeTabGroup.activeTab?.input;
    return input instanceof vscode.TabInputCustom ? input.uri : undefined;
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
        // Teardown continues so queues can drain and SQLite can always close.
    }
}

export async function activate(context: vscode.ExtensionContext): Promise<void> {
    const state_directory = vscode.Uri.joinPath(context.globalStorageUri, 'state');
    try {
        await vscode.workspace.fs.createDirectory(state_directory);
    } catch {
        // The opener below performs the authoritative open and selects the durable
        // degraded medium when this directory turns out to be unusable.
    }
    const database = await open_vscode_state_database({
        storageDirectory: state_directory.fsPath,
        appVersion: extension_version(context),
        getMaxStoredFiles: get_max_stored_files,
        openFallbackStore: () => ({
            store: create_file_state_store(context, get_max_stored_files),
            close: () => drain_keyed_state_runtime(context.globalState as object),
        }),
        warn: async (message) => {
            await vscode.window.showWarningMessage(message);
        },
    });

    let viewers: TableViewerRegistration | undefined;
    const disposables: vscode.Disposable[] = [];
    try {
        viewers = register_table_viewer(context, database.store);
        // Each registration is pushed as soon as it exists. A single
        // push(a, b, c) evaluates every argument before the array is touched, so
        // a failure registering the second command would leak the first past the
        // rollback below.
        const register = (
            command: string,
            handler: (uri?: vscode.Uri) => void,
        ): void => {
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
        register('tableViewer.openAsText', open_with('default', active_custom_tab_uri));
        disposables.push({ dispose: dispose_csv_preview });
        context.subscriptions.push(...disposables);
        active_runtime = { viewers, disposables, database };
    } catch (error) {
        // Nothing may keep the database open after a failed activation: VS Code
        // will not call deactivate for an activation that threw, and a retained
        // handle would block the coordination gate for the next attempt.
        for (const disposable of [...disposables].reverse()) dispose_best_effort(disposable);
        if (viewers) {
            dispose_best_effort(viewers);
            await Promise.allSettled([viewers.drain()]);
        }
        try {
            await database.close();
        } catch {
            // Preserve the activation failure that triggered this rollback.
        }
        throw error;
    }
}

export function deactivate(): Promise<void> {
    const runtime = active_runtime;
    if (!runtime) return active_teardown ?? Promise.resolve();
    active_runtime = undefined;
    const teardown = (async () => {
        // Dispose first so no new panel or preview work can begin, then let the
        // already-admitted controller writes settle, and only then close SQLite.
        // dispose_viewers() fences edit admission before its first await, so the
        // drain below observes a closed set.
        for (const disposable of runtime.disposables) dispose_best_effort(disposable);
        dispose_best_effort(runtime.viewers);
        try {
            await Promise.allSettled([runtime.viewers.drain()]);
        } finally {
            await runtime.database.close();
        }
    })();
    active_teardown = teardown;
    void teardown.finally(() => {
        if (active_teardown === teardown) active_teardown = undefined;
    }).catch(() => {});
    return teardown;
}
