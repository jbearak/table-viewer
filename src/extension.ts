import * as vscode from 'vscode';
import {
    register_table_viewer,
    TABLE_VIEW_TYPE,
    type TableViewerRegistration,
} from './custom-editor';
import {
    show_csv_preview,
    dispose_csv_preview,
    drain_csv_previews,
} from './csv-preview';
import {
    open_vscode_cosmetic_state_database,
    type OpenedVscodeCosmeticStateDatabase,
} from './vscode-cosmetic-state-database';
import { DEFAULT_MAX_STORED_FILES } from './state';

interface ActiveExtensionRuntime {
    readonly viewers: TableViewerRegistration;
    readonly commands: vscode.Disposable[];
    readonly database: OpenedVscodeCosmeticStateDatabase;
}

let active_runtime: ActiveExtensionRuntime | undefined;

function active_custom_tab_uri(): vscode.Uri | undefined {
    const input = vscode.window.tabGroups.activeTabGroup.activeTab?.input;
    return input instanceof vscode.TabInputCustom ? input.uri : undefined;
}

function extension_version(context: vscode.ExtensionContext): string {
    const version = (context.extension.packageJSON as { version?: unknown }).version;
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
        // The database opener below performs the authoritative open and selects its
        // in-memory cosmetic fallback when the directory is unusable.
    }
    const database = await open_vscode_cosmetic_state_database({
        storageDirectory: state_directory.fsPath,
        appVersion: extension_version(context),
        getMaxStoredFiles: get_max_stored_files,
        warn: async (message) => {
            await vscode.window.showWarningMessage(message);
        },
    });

    let viewers: TableViewerRegistration | undefined;
    const commands: vscode.Disposable[] = [];
    try {
        viewers = register_table_viewer(context, database.store);
        commands.push(vscode.commands.registerCommand(
            'tableViewer.showCsvPreviewToSide',
            (uri?: vscode.Uri) => {
                const target = uri ?? vscode.window.activeTextEditor?.document.uri;
                if (!target) return;
                show_csv_preview(
                    target,
                    context.extensionUri,
                    database.store,
                    vscode.ViewColumn.Beside,
                );
            },
        ));
        commands.push(vscode.commands.registerCommand(
            'tableViewer.showCsvPreview',
            (uri?: vscode.Uri) => {
                const target = uri ?? vscode.window.activeTextEditor?.document.uri;
                if (!target) return;
                show_csv_preview(
                    target,
                    context.extensionUri,
                    database.store,
                    vscode.ViewColumn.Active,
                );
            },
        ));
        commands.push(vscode.commands.registerCommand(
            'tableViewer.openCsvTable',
            (uri?: vscode.Uri) => {
                const target = uri ?? vscode.window.activeTextEditor?.document.uri;
                if (!target) return;
                void vscode.commands.executeCommand(
                    'vscode.openWith',
                    target,
                    TABLE_VIEW_TYPE,
                );
            },
        ));
        commands.push(vscode.commands.registerCommand(
            'tableViewer.openAsText',
            (uri?: vscode.Uri) => {
                const target = uri ?? active_custom_tab_uri();
                if (!target) return;
                void vscode.commands.executeCommand('vscode.openWith', target, 'default');
            },
        ));
        context.subscriptions.push(...commands);
        active_runtime = { viewers, commands, database };
    } catch (error) {
        for (const command of commands.reverse()) dispose_best_effort(command);
        if (viewers) {
            try {
                viewers.stop_admissions();
            } catch {
                // Continue rollback through disposal and drain.
            }
            dispose_best_effort(viewers);
            await Promise.allSettled([viewers.drain()]);
        }
        try {
            await database.close();
        } catch {
            // Preserve the activation failure that triggered rollback.
        }
        throw error;
    }
}

export async function deactivate(): Promise<void> {
    const runtime = active_runtime;
    active_runtime = undefined;
    if (!runtime) return;

    // First stop admissions and begin viewer/preview teardown so no new document
    // or controller work can begin. Viewer provider registration stays alive only
    // long enough for already-admitted native edit events to drain below.
    try {
        runtime.viewers.stop_admissions();
    } catch {
        // Continue ordered teardown; close must not be skipped by a host callback.
    }
    try {
        dispose_csv_preview();
    } catch {
        // Continue through controller drain.
    }
    for (const command of runtime.commands) dispose_best_effort(command);
    dispose_best_effort(runtime.viewers);

    try {
        // Then settle all document and controller queues, finalize the viewer
        // provider bridge, and only then close the direct SQLite handle. close()
        // is idempotent and is invoked exactly once here.
        await Promise.allSettled([
            runtime.viewers.drain(),
            drain_csv_previews(),
        ]);
    } finally {
        await runtime.database.close();
    }
}
