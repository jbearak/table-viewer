// Renderer bootstrap for the stored-file-state inspector window.
//
// Everything visible is built by the shared UI module, which the VS Code webview
// loads too. This file supplies the two things only the desktop can: a transport
// over IPC, and the `--vscode-*` variables VS Code would otherwise provide
// ambiently — applied before mounting so the first paint is already themed.
import { apply_theme_to_document } from '../main/theme';
import { mount_state_inspector } from '../../src/state-inspector/ui';
import type { StateInspectorApi } from '../preload/state-inspector-preload';
import { install_titlebar_from_api } from '../shared/titlebar';

const api = (window as unknown as { stateInspectorApi: StateInspectorApi }).stateInspectorApi;

apply_theme_to_document(document, api.get_theme());
api.on_theme_changed((payload) => apply_theme_to_document(document, payload));

mount_state_inspector(document.getElementById('root')!, {
    send: (request) => api.request(request),
});

// macOS themed title bar, drawn from the same `--vscode-*` variables applied
// above. Like the other dialogs it has no toolbar for a header band to
// continue, so it takes the window's own background.
install_titlebar_from_api(document, api, {
    background: 'var(--vscode-editor-background, #1e1e1e)',
});
