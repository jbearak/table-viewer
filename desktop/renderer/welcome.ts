// Renderer for the welcome window: the launcher shown when the app starts with
// no file to open (and from File → New Window). Opening a file from here
// replaces this window with the file's own viewer window — the main process
// closes it (see `open_files` in desktop/main/main.ts).
import type { WelcomeApi } from '../preload/welcome-preload';
import type { DesktopSettings } from '../main/desktop-config';
import type { ThemePayload } from '../main/theme';
import { SYSTEM_FONT, font_family_with_fallback } from '../main/theme-palette';

const welcome_api = (window as unknown as { welcomeApi: WelcomeApi }).welcomeApi;

function apply_theme(payload: ThemePayload): void {
    const vars = payload.variables;
    const root = document.documentElement;
    root.style.setProperty('--welcome-bg', vars['--vscode-editor-background']);
    root.style.setProperty('--welcome-fg', vars['--vscode-foreground']);
    root.style.setProperty('--welcome-border', vars['--vscode-panel-border']);
    root.style.setProperty('--welcome-button-bg', vars['--vscode-editorGroupHeader-tabsBackground']);
    root.style.setProperty('--welcome-hover-bg', vars['--vscode-list-hoverBackground']);
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
const preferences_button = document.getElementById('preferences') as HTMLButtonElement;

open_button.addEventListener('click', () => welcome_api.open_files());
preferences_button.addEventListener('click', () => welcome_api.open_preferences());
welcome_api.on_theme_changed(apply_theme);
welcome_api.on_settings_changed(apply_settings);
apply_theme(welcome_api.get_theme());
void welcome_api.get_settings().then(apply_settings);
