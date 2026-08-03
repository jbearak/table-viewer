import * as vscode from 'vscode';
import { register_table_viewer, TABLE_VIEW_TYPE } from './custom-editor';
import { show_csv_preview, dispose_csv_preview } from './csv-preview';
import {
    create_physical_edit_activation_boundary,
    PhysicalEditProtocolMarker,
    run_physical_edit_protocol_setup,
    type PhysicalEditActivationBoundary,
} from './physical-edit-activation';
import {
    evaluate_sqlite_migration_cold_start,
    prepare_sqlite_migration_arming,
} from './sqlite-migration-arming';

let active_boundary: PhysicalEditActivationBoundary | undefined;
let active_disposables: vscode.Disposable[] = [];
let drain_active_viewers: (() => Promise<void>) | undefined;

function active_custom_tab_uri(): vscode.Uri | undefined {
    const input = vscode.window.tabGroups.activeTabGroup.activeTab?.input;
    return input instanceof vscode.TabInputCustom ? input.uri : undefined;
}

export async function activate(context: vscode.ExtensionContext): Promise<void> {
    const coldArming = await evaluate_sqlite_migration_cold_start(context);
    const marker = new PhysicalEditProtocolMarker();
    const boundary = await create_physical_edit_activation_boundary(context, marker);
    if (coldArming.blocksStateWriters) await boundary.enter_view_only();
    active_boundary = boundary;

    const viewer_registration = register_table_viewer(
        context,
        boundary.store,
        () => boundary.viewOnly,
    );
    if (boundary.markerStatus === 'invalid') {
        void vscode.window.showErrorMessage(
            'Table Viewer could not verify the physical-edit protocol marker. Files remain available in view-only mode. Close and update every Table Viewer product, then repair or remove the unreadable or tampered coordination marker before arming the protocol again.',
        );
    }
    drain_active_viewers = () => viewer_registration.drain();
    let viewers_stopped = false;
    const stop_viewers = async () => {
        if (!viewers_stopped) {
            viewers_stopped = true;
            dispose_csv_preview();
        }
        // Re-invocation retries panels whose renderer did not answer a previous
        // bounded flush. Registrations are idempotent; failed panels stay open and
        // view-only until a later attempt succeeds.
        viewer_registration.dispose();
        await viewer_registration.drain();
    };

    const disposables = [
        viewer_registration,
        vscode.commands.registerCommand('tableViewer.setupPhysicalEditProtocol', async () => {
            await run_physical_edit_protocol_setup(marker, boundary, stop_viewers);
        }),
        vscode.commands.registerCommand('tableViewer.armSqliteMigration', async () => {
            await prepare_sqlite_migration_arming(context, boundary, stop_viewers);
        }),
        vscode.commands.registerCommand('tableViewer.upgradeToSqlitePersistence', async () => {
            // Direct upgraders use the identical seed/snapshot/restart sequence; no
            // shortcut may create a canonical database or skip the cold boundary.
            await prepare_sqlite_migration_arming(context, boundary, stop_viewers);
        }),
        vscode.commands.registerCommand('tableViewer.showCsvPreviewToSide', (uri?: vscode.Uri) => {
            const target = uri ?? vscode.window.activeTextEditor?.document.uri;
            if (!target) return;
            show_csv_preview(target, context.extensionUri, boundary.store, vscode.ViewColumn.Beside);
        }),
        vscode.commands.registerCommand('tableViewer.showCsvPreview', (uri?: vscode.Uri) => {
            const target = uri ?? vscode.window.activeTextEditor?.document.uri;
            if (!target) return;
            show_csv_preview(target, context.extensionUri, boundary.store, vscode.ViewColumn.Active);
        }),
        vscode.commands.registerCommand('tableViewer.openCsvTable', (uri?: vscode.Uri) => {
            const target = uri ?? vscode.window.activeTextEditor?.document.uri;
            if (!target) return;
            void vscode.commands.executeCommand('vscode.openWith', target, TABLE_VIEW_TYPE);
        }),
        vscode.commands.registerCommand('tableViewer.openAsText', (uri?: vscode.Uri) => {
            const target = uri ?? active_custom_tab_uri();
            if (!target) return;
            void vscode.commands.executeCommand('vscode.openWith', target, 'default');
        }),
        { dispose: dispose_csv_preview },
    ];
    active_disposables = disposables;
    context.subscriptions.push(...disposables);
}

export async function deactivate(): Promise<void> {
    const disposables = active_disposables;
    active_disposables = [];
    for (const disposable of disposables) {
        try {
            disposable.dispose();
        } catch {
            // Continue teardown; a later drain still gets its bounded chance to settle.
        }
    }
    const drain_viewers = drain_active_viewers;
    drain_active_viewers = undefined;
    const boundary = active_boundary;
    active_boundary = undefined;
    await Promise.allSettled([
        drain_viewers?.() ?? Promise.resolve(),
        boundary?.drain() ?? Promise.resolve(),
    ]);
}
