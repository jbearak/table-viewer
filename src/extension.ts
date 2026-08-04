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
    sqlite_migration_blocks_state_writers_on_activation,
    type ColdArmingResult,
} from './sqlite-migration-arming';

interface ActiveExtensionLifecycle {
    readonly generation: number;
    readonly cancellation: AbortController;
    readonly migrationTasks: Set<Promise<unknown>>;
    boundary?: PhysicalEditActivationBoundary;
    disposables: vscode.Disposable[];
    drainViewers?: () => Promise<void>;
}

let active_activation: ActiveExtensionLifecycle | undefined;
let active_teardown: Promise<void> | undefined;
let activation_generation = 0;

function active_custom_tab_uri(): vscode.Uri | undefined {
    const input = vscode.window.tabGroups.activeTabGroup.activeTab?.input;
    return input instanceof vscode.TabInputCustom ? input.uri : undefined;
}

export async function activate(context: vscode.ExtensionContext): Promise<void> {
    const lifecycle: ActiveExtensionLifecycle = {
        generation: ++activation_generation,
        cancellation: new AbortController(),
        migrationTasks: new Set(),
        disposables: [],
    };
    active_activation = lifecycle;
    const is_current_activation = () => active_activation === lifecycle
        && activation_generation === lifecycle.generation
        && !lifecycle.cancellation.signal.aborted;
    const track_migration_task = <T>(work: Promise<T>): Promise<T> => {
        lifecycle.migrationTasks.add(work);
        void work.finally(() => lifecycle.migrationTasks.delete(work)).catch(() => {});
        return work;
    };
    const marker = new PhysicalEditProtocolMarker();
    const boundary = await create_physical_edit_activation_boundary(context, marker);
    if (!is_current_activation()) {
        await boundary.drain();
        return;
    }
    if (sqlite_migration_blocks_state_writers_on_activation(context)) {
        await boundary.enter_view_only();
        if (!is_current_activation()) {
            await boundary.drain();
            return;
        }
    }
    lifecycle.boundary = boundary;
    let coldArmingCompletion: Promise<ColdArmingResult> | undefined;
    let armingOperation: Promise<boolean> | undefined;
    const await_cold_arming = async () => {
        if (!coldArmingCompletion) {
            throw new Error('Table Viewer activation has not started SQLite cold-boundary evaluation.');
        }
        await coldArmingCompletion;
    };
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
    lifecycle.drainViewers = () => viewer_registration.drain();
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
    const run_migration_arming = (): Promise<boolean> => {
        if (armingOperation) return armingOperation;
        const current = track_migration_task((async () => {
            await await_cold_arming();
            if (!is_current_activation()) return false;
            return prepare_sqlite_migration_arming(
                context,
                boundary,
                stop_viewers,
                is_current_activation,
                lifecycle.cancellation.signal,
            );
        })());
        armingOperation = current;
        void current.then(
            () => { if (armingOperation === current) armingOperation = undefined; },
            () => { if (armingOperation === current) armingOperation = undefined; },
        );
        return current;
    };

    const disposables = [
        viewer_registration,
        vscode.commands.registerCommand('tableViewer.setupPhysicalEditProtocol', async () => {
            await track_migration_task((async () => {
                await await_cold_arming();
                if (!is_current_activation()) return;
                await run_physical_edit_protocol_setup(
                    marker,
                    boundary,
                    stop_viewers,
                    is_current_activation,
                    lifecycle.cancellation.signal,
                );
            })());
        }),
        vscode.commands.registerCommand('tableViewer.armSqliteMigration', async () => {
            await run_migration_arming();
        }),
        vscode.commands.registerCommand('tableViewer.upgradeToSqlitePersistence', async () => {
            // Direct upgraders use the identical seed/snapshot/restart sequence; no
            // shortcut may create a canonical database or skip the cold boundary.
            await run_migration_arming();
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
    lifecycle.disposables = disposables;
    context.subscriptions.push(...disposables);
    coldArmingCompletion = track_migration_task(evaluate_sqlite_migration_cold_start(
        context,
        is_current_activation,
        lifecycle.cancellation.signal,
    ).catch(() => ({
        blocksStateWriters: true,
        phase: 'failedClosed' as const,
    })));
}

export function deactivate(): Promise<void> {
    const lifecycle = active_activation;
    if (!lifecycle) return active_teardown ?? Promise.resolve();
    active_activation = undefined;
    activation_generation += 1;
    lifecycle.cancellation.abort();
    const teardown = (async () => {
        for (const disposable of lifecycle.disposables) {
            try {
                disposable.dispose();
            } catch {
                // Continue teardown; the owned tasks and drains must still settle.
            }
        }
        while (lifecycle.migrationTasks.size > 0) {
            await Promise.allSettled([...lifecycle.migrationTasks]);
        }
        await Promise.allSettled([
            lifecycle.drainViewers?.() ?? Promise.resolve(),
            lifecycle.boundary?.drain() ?? Promise.resolve(),
        ]);
    })();
    active_teardown = teardown;
    void teardown.finally(() => {
        if (active_teardown === teardown) active_teardown = undefined;
    }).catch(() => {});
    return teardown;
}
