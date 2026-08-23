// Renderer for the welcome window: the launcher shown when the app starts with
// no file to open (and from File → New Window). Opening a file from here
// replaces this window with the file's own viewer window — the main process
// closes it (see `open_files` in desktop/main/main.ts).
//
// Three actions and a Recent rail. The labelling rules for a rail row live in
// ../shared/recent-display.ts, where they are testable without a DOM.
import type { WelcomeApi } from '../preload/welcome-preload';
import type { DesktopSettings } from '../main/desktop-config';
import type { RecentEntry } from '../main/recent-documents';
import type { ThemePayload } from '../main/theme';
import { SYSTEM_FONT, font_family_with_fallback } from '../main/theme-palette';
import { recent_row } from '../shared/recent-display';
import { install_titlebar_from_api } from '../shared/titlebar';

const welcome_api = (window as unknown as { welcomeApi: WelcomeApi }).welcomeApi;

function apply_theme(payload: ThemePayload): void {
    const vars = payload.variables;
    const root = document.documentElement;
    root.style.setProperty('--welcome-bg', vars['--vscode-editor-background']);
    root.style.setProperty('--welcome-fg', vars['--vscode-foreground']);
    root.style.setProperty('--welcome-border', vars['--vscode-panel-border']);
    root.style.setProperty('--welcome-button-bg', vars['--vscode-editorGroupHeader-tabsBackground']);
    root.style.setProperty('--welcome-hover-bg', vars['--vscode-list-hoverBackground']);
    // The Recent rail's second lines and the drop hint; the focus ring and the
    // drag overlay's border.
    root.style.setProperty('--welcome-muted-fg', vars['--vscode-descriptionForeground']);
    root.style.setProperty('--welcome-accent', vars['--vscode-focusBorder']);
    root.style.colorScheme = payload.kind;
}

/** The font preference styles the whole app, so this window follows it too. */
function apply_settings(settings: DesktopSettings): void {
    const root = document.documentElement;
    root.style.setProperty(
        '--welcome-font-family',
        font_family_with_fallback(settings.fontFamily, SYSTEM_FONT),
    );
    root.style.setProperty('--welcome-font-size', `${settings.fontSize}px`);
}

const open_button = document.getElementById('open') as HTMLButtonElement;
const compare_button = document.getElementById('compare') as HTMLButtonElement;
const preferences_button = document.getElementById('preferences') as HTMLButtonElement;
const recent_panel = document.getElementById('recent') as HTMLElement;
const recent_list = document.getElementById('recent-list') as HTMLElement;
const clear_recent_button = document.getElementById('clear-recent') as HTMLButtonElement;

open_button.addEventListener('click', () => welcome_api.open_files());
compare_button.addEventListener('click', () => welcome_api.open_compare());
preferences_button.addEventListener('click', () => welcome_api.open_preferences());
clear_recent_button.addEventListener('click', () => welcome_api.clear_recent());

/**
 * The home directory the rail abbreviates paths against.
 *
 * Taken from the entries themselves rather than asked for over IPC: every path
 * in the list is one this app opened, so the longest common `/Users/<name>` or
 * `/home/<name>` prefix among them is the home directory whenever any of them
 * is under it — and when none are, there is nothing to abbreviate anyway.
 * Cheaper than another channel, and wrong only in the case where it makes no
 * visible difference.
 */
function infer_home(entries: readonly RecentEntry[]): string {
    for (const entry of entries) {
        const paths = entry.kind === 'file'
            ? [entry.path]
            : [entry.originalPath, entry.modifiedPath];
        for (const file_path of paths) {
            const match = /^([\\/](?:Users|home)[\\/][^\\/]+)[\\/]/.exec(file_path);
            if (match) return match[1];
        }
    }
    return '';
}

function render_recent(entries: readonly RecentEntry[]): void {
    recent_list.replaceChildren();
    recent_panel.hidden = entries.length === 0;
    const home = infer_home(entries);
    for (const entry of entries) {
        const row = recent_row(entry, home);
        const button = document.createElement('button');
        button.className = 'recent-entry';
        button.title = row.tooltip;
        const name = document.createElement('span');
        name.className = 'name';
        name.textContent = row.title;
        button.append(name);
        if (row.location !== '') {
            const location = document.createElement('span');
            location.className = 'location';
            location.textContent = row.location;
            button.append(location);
        }
        button.addEventListener('click', () => welcome_api.open_recent(entry));
        recent_list.append(button);
    }
}

welcome_api.on_recent_changed(render_recent);
void welcome_api.get_recent().then(render_recent);

// Drag and drop. The listeners are on the document rather than on a drop zone
// element: the whole window is the target, and the hint in the actions column
// says so.
//
// `dragover` must preventDefault on every event, not merely the first — the drop
// is refused unless the immediately preceding dragover was cancelled, so a
// handler that only set up the overlay once would show the affordance and then
// reject the drop.
let drag_depth = 0;

function set_dragging(active: boolean): void {
    document.body.classList.toggle('dragging', active);
}

document.addEventListener('dragenter', (event) => {
    event.preventDefault();
    // Nested elements each fire enter/leave as the pointer crosses them, so a
    // boolean would clear on the first inner leave. Counted instead.
    drag_depth += 1;
    set_dragging(true);
});
document.addEventListener('dragover', (event) => {
    event.preventDefault();
    if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy';
});
document.addEventListener('dragleave', (event) => {
    event.preventDefault();
    drag_depth = Math.max(0, drag_depth - 1);
    if (drag_depth === 0) set_dragging(false);
});
document.addEventListener('drop', (event) => {
    event.preventDefault();
    drag_depth = 0;
    set_dragging(false);
    const files = event.dataTransfer ? Array.from(event.dataTransfer.files) : [];
    if (files.length > 0) welcome_api.open_dropped(files);
});

welcome_api.on_theme_changed(apply_theme);
welcome_api.on_settings_changed(apply_settings);
apply_theme(welcome_api.get_theme());
void welcome_api.get_settings().then(apply_settings);

// macOS themed title bar. No band color and no rule: this window has no
// toolbar for the strip to continue, so it takes the window's own background
// and reads as one surface.
install_titlebar_from_api(document, welcome_api, { background: 'var(--welcome-bg)' });
