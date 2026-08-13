// Renderer bootstrap for the stored-file-state inspector window.
//
// Everything visible is built by the shared UI module, which the VS Code webview
// loads too. This file supplies the two things only the desktop can: a transport
// over IPC, and the `--vscode-*` variables VS Code would otherwise provide
// ambiently — applied before mounting so the first paint is already themed.
import { apply_theme_to_document } from '../main/theme';
import { mount_state_inspector } from '../../src/state-inspector/ui';
import type { StateInspectorApi } from '../preload/state-inspector-preload';
import { install_titlebar, set_titlebar_active, set_titlebar_zoom } from '../shared/titlebar';

const api = (window as unknown as { stateInspectorApi: StateInspectorApi }).stateInspectorApi;

apply_theme_to_document(document, api.get_theme());
api.on_theme_changed((payload) => apply_theme_to_document(document, payload));

mount_state_inspector(document.getElementById('root')!, {
    send: (request) => api.request(request),
});

// macOS themed title bar: `titleBarStyle: 'hidden'` hides the native
// bar (and its title), so this window redraws the strip itself, from the same
// `--vscode-*` variables applied above. It takes the window's own background: like
// the other dialogs it has no toolbar for a header band to continue. No path menu
// either — this window inspects many files rather than representing one.
install_titlebar(document, {
    title: document.title,
    inset: api.titlebar_inset,
    zoom: api.titlebar_zoom(),
    active: api.titlebar_active(),
    on_drag: (phase, x, y) => api.drag_titlebar(phase, x, y),
    on_zoom_window: () => api.zoom_titlebar_window(),
    style: {
        background: 'var(--vscode-editor-background, #1e1e1e)',
    },
});
api.on_titlebar_zoom((zoom) => set_titlebar_zoom(document, zoom));
api.on_titlebar_active((active) => set_titlebar_active(document, active));
