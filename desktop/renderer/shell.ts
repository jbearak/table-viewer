// Tab bar renderer for the desktop main window. Talks to the main-process
// TabManager through the shellApi exposed by shell-preload.ts.
import type { ShellApi } from '../preload/shell-preload';
import type { ShellTabInfo } from '../shared/ipc';
import type { DesktopSettings } from '../main/desktop-config';
import type { ThemePayload } from '../main/theme';
import { tab_bar_height } from '../shared/chrome';

const shell_api = (window as unknown as { shellApi: ShellApi }).shellApi;

const tab_bar = document.getElementById('tab-bar') as HTMLDivElement;
const empty_state = document.getElementById('empty-state') as HTMLDivElement;
const empty_open = document.getElementById('empty-open') as HTMLButtonElement;
const empty_settings = document.getElementById('empty-settings') as HTMLButtonElement;

function apply_theme(payload: ThemePayload): void {
    const vars = payload.variables;
    const root = document.documentElement;
    root.style.setProperty('--shell-bg', vars['--vscode-editorGroupHeader-tabsBackground']);
    root.style.setProperty('--shell-fg', vars['--vscode-foreground']);
    root.style.setProperty('--shell-border', vars['--vscode-panel-border']);
    root.style.setProperty('--shell-active-bg', vars['--vscode-editor-background']);
    root.style.setProperty('--shell-hover-bg', vars['--vscode-list-hoverBackground']);
    root.style.setProperty('--shell-muted', vars['--vscode-descriptionForeground']);
    root.style.colorScheme = payload.kind;
}

/** The font preference styles the whole app, not just table views, so the tab
 *  bar follows it too. The bar height must stay in step with the main-process
 *  layout (shared/chrome.ts). */
function apply_settings(settings: DesktopSettings): void {
    const root = document.documentElement;
    const family = settings.fontFamily.trim();
    if (family) root.style.setProperty('--shell-font-family', family);
    else root.style.removeProperty('--shell-font-family');
    root.style.setProperty('--shell-font-size', `${settings.fontSize}px`);
    root.style.setProperty(
        '--shell-tab-bar-height',
        `${tab_bar_height(settings.fontSize)}px`,
    );
}

function render_tabs(tabs: ShellTabInfo[]): void {
    tab_bar.replaceChildren();
    empty_state.style.display = tabs.length === 0 ? 'flex' : 'none';
    for (const tab of tabs) {
        const button = document.createElement('button');
        button.className = tab.active ? 'tab active' : 'tab';
        button.title = tab.filePath;
        button.addEventListener('click', () => shell_api.activate_tab(tab.id));
        button.addEventListener('auxclick', (event) => {
            if (event.button === 1) shell_api.close_tab(tab.id);
        });

        const title = document.createElement('span');
        title.className = 'title';
        title.textContent = tab.title;
        button.appendChild(title);

        const close = document.createElement('button');
        close.className = 'close';
        close.textContent = '×';
        close.setAttribute('aria-label', `Close ${tab.title}`);
        close.addEventListener('click', (event) => {
            event.stopPropagation();
            shell_api.close_tab(tab.id);
        });
        button.appendChild(close);

        tab_bar.appendChild(button);
    }

    const open_button = document.createElement('button');
    open_button.id = 'open-button';
    open_button.textContent = '+';
    open_button.title = 'Open File…';
    open_button.addEventListener('click', () => shell_api.open_files());
    tab_bar.appendChild(open_button);
}

empty_open.addEventListener('click', () => shell_api.open_files());
empty_settings.addEventListener('click', () => shell_api.open_preferences());
shell_api.on_tabs_changed(render_tabs);
shell_api.on_theme_changed(apply_theme);
shell_api.on_settings_changed(apply_settings);
apply_theme(shell_api.get_theme());
void shell_api.get_settings().then(apply_settings);
void shell_api.get_tabs().then(render_tabs);
