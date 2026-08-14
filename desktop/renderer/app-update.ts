import type { AppUpdateApi } from '../preload/app-update-preload';
import {
    displayed_update_percent,
    type AppUpdateWindowState,
} from '../main/app-update-window';
import type { DesktopSettings } from '../main/desktop-config';
import type { ThemePayload } from '../main/theme';
import { SYSTEM_FONT, font_family_with_fallback } from '../main/theme-palette';
import { install_titlebar_from_api } from '../shared/titlebar';

const update_api = (window as unknown as { appUpdateApi: AppUpdateApi }).appUpdateApi;
const heading = document.getElementById('heading') as HTMLHeadingElement;
const detail = document.getElementById('detail') as HTMLParagraphElement;
const dismissal_note = document.getElementById('dismissalNote') as HTMLParagraphElement;
const progress = document.getElementById('progress') as HTMLDivElement;
const progress_bar = document.getElementById('progressBar') as HTMLProgressElement;
const progress_amount = document.getElementById('progressAmount') as HTMLSpanElement;
const progress_percent = document.getElementById('progressPercent') as HTMLSpanElement;
const secondary = document.getElementById('secondary') as HTMLButtonElement;
const primary = document.getElementById('primary') as HTMLButtonElement;
const icon = document.getElementById('icon') as HTMLDivElement;

function apply_theme(payload: ThemePayload): void {
    const vars = payload.variables;
    const root = document.documentElement;
    root.style.setProperty('--update-bg', vars['--vscode-editor-background']);
    root.style.setProperty('--update-fg', vars['--vscode-foreground']);
    root.style.setProperty('--update-border', vars['--vscode-panel-border']);
    root.style.setProperty('--update-muted', vars['--vscode-descriptionForeground']);
    root.style.setProperty('--update-button-bg', vars['--vscode-editorGroupHeader-tabsBackground']);
    root.style.setProperty('--update-hover-bg', vars['--vscode-list-hoverBackground']);
    root.style.setProperty('--update-primary-bg', vars['--vscode-button-background']);
    root.style.setProperty('--update-primary-fg', vars['--vscode-button-foreground']);
    root.style.setProperty('--update-primary-hover-bg', vars['--vscode-button-hoverBackground']);
    root.style.setProperty('--update-progress-bg', vars['--vscode-progressBar-background']);
    root.style.colorScheme = payload.kind;
}

function apply_fonts(settings: DesktopSettings): void {
    const root = document.documentElement;
    root.style.setProperty(
        '--update-font-family',
        font_family_with_fallback(settings.fontFamily, SYSTEM_FONT),
    );
    root.style.setProperty('--update-font-size', `${settings.fontSize}px`);
}

function format_bytes(value: number): string {
    if (!Number.isFinite(value) || value < 0) return '0 MB';
    const units = ['bytes', 'KB', 'MB', 'GB'];
    let amount = value;
    let unit = 0;
    while (amount >= 1_000 && unit < units.length - 1) {
        amount /= 1_000;
        unit += 1;
    }
    const digits = unit === 0 || amount >= 10 ? 0 : 1;
    return `${amount.toFixed(digits)} ${units[unit]}`;
}

function set_text(element: HTMLElement, value: string): void {
    if (element.textContent !== value) element.textContent = value;
}

function render(state: AppUpdateWindowState): void {
    document.body.dataset.state = state.kind;
    progress.hidden = state.kind !== 'downloading';
    dismissal_note.hidden = state.kind !== 'available';
    primary.hidden = state.kind === 'downloading';
    secondary.hidden = state.kind === 'downloading';

    if (state.kind === 'available') {
        icon.textContent = '↓';
        set_text(heading, `Table Viewer ${state.version} is available`);
        detail.textContent = state.installUpdates
            ? 'Download the update now and keep working while it finishes.'
            : 'Download the latest release from GitHub, then replace this app manually.';
        dismissal_note.textContent = `If you skip ${state.version}, you won’t be notified about it again. We’ll only notify you when a newer version is available.`;
        secondary.textContent = `Skip ${state.version}`;
        primary.textContent = state.installUpdates ? 'Download update' : 'Open GitHub Releases';
        return;
    }
    if (state.kind === 'downloading') {
        icon.textContent = '↓';
        // The heading is the major-state live region. Do not replace its text
        // node for each progress event or screen readers may re-announce it.
        set_text(heading, `Downloading Table Viewer ${state.version}`);
        detail.textContent = 'You can keep working. We’ll ask before restarting the app.';
        const current = state.progress;
        if (!current || current.total <= 0) {
            progress_bar.removeAttribute('value');
            progress_amount.textContent = 'Starting download…';
            progress_percent.textContent = '';
        } else {
            const percent = displayed_update_percent(current.percent);
            progress_bar.value = percent;
            progress_amount.textContent = `${format_bytes(current.transferred)} of ${format_bytes(current.total)}`;
            progress_percent.textContent = `${percent}%`;
        }
        return;
    }
    icon.textContent = '✓';
    set_text(heading, 'Update ready to install');
    detail.textContent = `Restart Table Viewer to finish installing version ${state.version}.`;
    secondary.textContent = 'Later';
    primary.textContent = 'Restart and install';
}

secondary.addEventListener('click', () => update_api.perform('secondary'));
primary.addEventListener('click', () => update_api.perform('primary'));

apply_theme(update_api.get_theme());
update_api.on_theme_changed(apply_theme);
update_api.on_settings_changed(apply_fonts);
void update_api.get_settings().then(apply_fonts);
update_api.on_state_changed(render);
const initial_state = update_api.get_state();
if (initial_state) render(initial_state);

install_titlebar_from_api(document, update_api, {
    background: 'var(--update-bg)',
    border: 'var(--update-border)',
});
