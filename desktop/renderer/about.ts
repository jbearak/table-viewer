// About window renderer. A custom window rather than the native macOS About
// panel because GPLv3's "Appropriate Legal Notices" expectation for interactive
// programs wants the license and notices reachable — and the native panel
// cannot host links.
import type { AboutApi } from '../preload/about-preload';
import type { DesktopSettings } from '../main/desktop-config';
import type { ThemePayload } from '../main/theme';

const about_api = (window as unknown as { aboutApi: AboutApi }).aboutApi;

/** Same remapping the other chrome windows do (see prefs.ts / welcome.ts):
 *  a theme is a map of --vscode-* variables, which each window projects onto
 *  its own locals. */
function apply_theme(payload: ThemePayload): void {
    const vars = payload.variables;
    const root = document.documentElement;
    root.style.setProperty('--about-bg', vars['--vscode-editor-background']);
    root.style.setProperty('--about-fg', vars['--vscode-foreground']);
    root.style.setProperty('--about-border', vars['--vscode-panel-border']);
    root.style.setProperty('--about-button-bg', vars['--vscode-editorGroupHeader-tabsBackground']);
    root.style.setProperty('--about-hover-bg', vars['--vscode-list-hoverBackground']);
    root.style.setProperty('--about-muted', vars['--vscode-descriptionForeground']);
    root.style.colorScheme = payload.kind;
}

/** The font preference styles the whole app, so this window follows it too. */
function apply_fonts(settings: DesktopSettings): void {
    const root = document.documentElement;
    const family = settings.fontFamily.trim();
    if (family) root.style.setProperty('--about-font-family', family);
    else root.style.removeProperty('--about-font-family');
    root.style.setProperty('--about-font-size', `${settings.fontSize}px`);
}

const version = document.getElementById('version') as HTMLDivElement;
version.textContent = `Version ${about_api.get_info().version}`;

(document.getElementById('license') as HTMLButtonElement)
    .addEventListener('click', () => about_api.open_link('license'));
(document.getElementById('notices') as HTMLButtonElement)
    .addEventListener('click', () => about_api.open_link('notices'));
(document.getElementById('bundledNotices') as HTMLButtonElement)
    .addEventListener('click', () => about_api.open_notices());

apply_theme(about_api.get_theme());
about_api.on_theme_changed(apply_theme);
about_api.on_settings_changed(apply_fonts);
void about_api.get_settings().then(apply_fonts);
