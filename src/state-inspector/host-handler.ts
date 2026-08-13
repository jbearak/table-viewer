/**
 * Serves inspector requests from the maintenance layer.
 *
 * Both products build one of these and expose it over their own transport, so
 * the desktop window and the VS Code panel answer identically. It holds no
 * state: every request is resolved against the database as it is right now,
 * because a UI that has been open for ten minutes must not delete based on what
 * it saw when it opened.
 */
import type { StoredFileStateMaintenance } from '../sqlite-file-state-maintenance';
import type {
    StateInspectorRequest,
    StateInspectorResponse,
} from './protocol';

export interface StateInspectorHostOptions {
    readonly maintenance: StoredFileStateMaintenance;
    readonly databasePath: string;
}

export type StateInspectorHandler = (
    request: StateInspectorRequest,
) => Promise<StateInspectorResponse>;

export function create_state_inspector_handler(
    options: StateInspectorHostOptions,
): StateInspectorHandler {
    return async (request) => {
        try {
            switch (request.kind) {
                case 'inspect': {
                    const inventory = await options.maintenance.inspect();
                    return {
                        kind: 'inventory',
                        inventory: { ...inventory, databasePath: options.databasePath },
                    };
                }
                case 'preview': {
                    const preview = await options.maintenance.preview(request.selection);
                    return {
                        kind: 'preview',
                        preview: {
                            selection: request.selection,
                            targetPaths: preview.targets.map((entry) => entry.path),
                            totalSizeBytes: preview.targets
                                .reduce((total, entry) => total + entry.sizeBytes, 0),
                            pendingEditPaths: preview.pendingEditPaths,
                            protectedPaths: preview.protectedPaths,
                        },
                    };
                }
                case 'trim': {
                    const result = await options.maintenance.trim({
                        paths: request.paths,
                        confirmedPendingEditPaths: request.confirmedPendingEditPaths,
                    });
                    return {
                        kind: 'trimmed',
                        summary: {
                            deletedCount: result.deletedPaths.length,
                            skippedProtectedCount: result.skippedProtectedPaths.length,
                            skippedUnconfirmedCount: result.skippedUnconfirmedPaths.length,
                            vacuum: result.vacuum,
                            reclaimedBytes: result.reclaimedBytes,
                        },
                    };
                }
            }
        } catch (error) {
            // Failures become a message rather than a rejection so one bad
            // request cannot tear down the window. The error object itself does
            // not cross the boundary: it is not reliably structured-cloneable,
            // and every transport here has to serialize what it sends.
            return {
                kind: 'error',
                message: error instanceof Error ? error.message : 'Unknown error.',
            };
        }
    };
}
