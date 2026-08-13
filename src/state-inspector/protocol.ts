/**
 * The whole contract between the inspector UI and whichever host is running it.
 *
 * The UI is one implementation running in two places — an Electron window and a
 * VS Code webview — so everything it needs from a host lives behind this one
 * request/response port. Neither side imports `electron` or `vscode`: the
 * desktop satisfies it over `ipcRenderer.invoke`, VS Code over correlated
 * `postMessage` calls, and the UI cannot tell the difference.
 */
import type {
    StoredFileStateEntry,
    StoredFileStateTrimSelection,
    StoredFileStateVacuum,
} from '../sqlite-file-state-maintenance';

export type { StoredFileStateEntry, StoredFileStateTrimSelection };

export interface StateInspectorInventory {
    readonly entries: readonly StoredFileStateEntry[];
    readonly totalEntryCount: number;
    readonly databaseSizeBytes: number;
    /** Shown so the user knows which database they are looking at. */
    readonly databasePath: string;
}

/** What a selection resolves to, and what confirming it would cost. */
export interface StateInspectorPreview {
    readonly selection: StoredFileStateTrimSelection;
    readonly targetPaths: readonly string[];
    readonly totalSizeBytes: number;
    /** Named verbatim in the second confirmation; deleting these loses edits. */
    readonly pendingEditPaths: readonly string[];
    /** Matched but in use, so it will be left alone whatever the user chooses. */
    readonly protectedPaths: readonly string[];
}

export interface StateInspectorTrimSummary {
    readonly deletedCount: number;
    readonly skippedProtectedCount: number;
    readonly skippedUnconfirmedCount: number;
    readonly vacuum: StoredFileStateVacuum;
    readonly reclaimedBytes: number;
}

export type StateInspectorRequest =
    | { readonly kind: 'inspect' }
    | { readonly kind: 'preview'; readonly selection: StoredFileStateTrimSelection }
    | {
        readonly kind: 'trim';
        readonly paths: readonly string[];
        readonly confirmedPendingEditPaths: readonly string[];
    };

export type StateInspectorResponse =
    | { readonly kind: 'inventory'; readonly inventory: StateInspectorInventory }
    | { readonly kind: 'preview'; readonly preview: StateInspectorPreview }
    | { readonly kind: 'trimmed'; readonly summary: StateInspectorTrimSummary }
    | { readonly kind: 'error'; readonly message: string };

/** How the UI reaches its host. One call, one reply. */
export interface StateInspectorTransport {
    send(request: StateInspectorRequest): Promise<StateInspectorResponse>;
}
