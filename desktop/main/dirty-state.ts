// Whether a viewer window is holding unsaved CSV edits, derived from the viewer
// protocol messages already flowing past `desktop/main/viewer-windows.ts`.
//
// Unsaved edits are durable — the controller persists `pendingEdits` per file and
// hands them back when the file is reopened — so this is purely an indicator: it
// tells the user which window has a draft in it (a dot in the macOS close button,
// a marked title elsewhere). Nothing here affects saving or closing.
//
// Both directions carry the signal, and both are needed:
//   • webview → host `pendingEditsChanged` — the live signal while editing, and
//     the one that clears (`edits: null`) after a save.
//   • host → webview `editSessionResult` / `workbookSnapshot` — a draft restored
//     from a previous session arrives this way; the webview only echoes
//     `pendingEditsChanged` once it is in edit mode with a session.
//
// Pure module (no electron import) so it is unit-testable.
import type { HostMessage, WebviewMessage } from '../../src/types';

function has_edits(edits: object | null | undefined): boolean {
    return !!edits && Object.keys(edits).length > 0;
}

/**
 * Dirty state implied by a host → webview message, or `undefined` when the
 * message says nothing about it (the caller then leaves the state alone).
 */
export function dirty_from_host_message(message: HostMessage): boolean | undefined {
    switch (message.type) {
        case 'editSessionResult':
            // A refused request neither grants a session nor carries a draft.
            return message.granted ? has_edits(message.pendingEdits) : undefined;
        case 'workbookSnapshot':
            return has_edits(message.snapshot.state.pendingEdits);
        default:
            return undefined;
    }
}

/** Dirty state implied by a webview → host message, or `undefined` if none. */
export function dirty_from_webview_message(message: WebviewMessage): boolean | undefined {
    return message.type === 'pendingEditsChanged' ? has_edits(message.edits) : undefined;
}
