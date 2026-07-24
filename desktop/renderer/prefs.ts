// Preferences window renderer: edits the desktop settings file through
// prefs-preload.ts. Changes persist immediately and notify ConfigPort
// listeners in the main process (font-family changes propagate live; the
// other settings apply on the next file load).
import type { PrefsApi } from '../preload/prefs-preload';
import type { DesktopSettings } from '../main/desktop-config';
import type { ThemePayload } from '../main/theme';

const prefs_api = (window as unknown as { prefsApi: PrefsApi }).prefsApi;

const font_family = document.getElementById('fontFamily') as HTMLInputElement;
const tab_orientation = document.getElementById('tabOrientation') as HTMLSelectElement;
const csv_max_rows = document.getElementById('csvMaxRows') as HTMLInputElement;
const max_file_size = document.getElementById('maxFileSizeMiB') as HTMLInputElement;
const status = document.getElementById('status') as HTMLDivElement;

function apply_theme(payload: ThemePayload): void {
    const vars = payload.variables;
    const root = document.documentElement;
    root.style.setProperty('--prefs-bg', vars['--vscode-editor-background']);
    root.style.setProperty('--prefs-fg', vars['--vscode-foreground']);
    root.style.setProperty('--prefs-border', vars['--vscode-input-border']);
    root.style.setProperty('--prefs-input-bg', vars['--vscode-input-background']);
    root.style.setProperty('--prefs-muted', vars['--vscode-descriptionForeground']);
    root.style.colorScheme = payload.kind;
}

function populate(settings: DesktopSettings): void {
    font_family.value = settings.fontFamily;
    tab_orientation.value = settings.tabOrientation;
    csv_max_rows.value = String(settings.csvMaxRows);
    max_file_size.value = String(settings.maxFileSizeMiB);
}

let status_timer: ReturnType<typeof setTimeout> | undefined;
function save(partial: Partial<DesktopSettings>): void {
    void prefs_api.set_settings(partial).then((settings) => {
        populate(settings);
        status.textContent = 'Saved';
        if (status_timer) clearTimeout(status_timer);
        status_timer = setTimeout(() => {
            status.textContent = '';
        }, 1200);
    });
}

font_family.addEventListener('change', () => save({ fontFamily: font_family.value }));
tab_orientation.addEventListener('change', () => {
    save({ tabOrientation: tab_orientation.value === 'vertical' ? 'vertical' : 'horizontal' });
});
function numeric_value(input: HTMLInputElement): number | null {
    if (input.value.trim() === '') return null;
    const value = Number(input.value);
    return Number.isFinite(value) ? value : null;
}
csv_max_rows.addEventListener('change', () => {
    const value = numeric_value(csv_max_rows);
    if (value !== null) save({ csvMaxRows: value });
    else void prefs_api.get_settings().then(populate);
});
max_file_size.addEventListener('change', () => {
    const value = numeric_value(max_file_size);
    if (value !== null) save({ maxFileSizeMiB: value });
    else void prefs_api.get_settings().then(populate);
});

apply_theme(prefs_api.get_theme());
prefs_api.on_theme_changed(apply_theme);
void prefs_api.get_settings().then(populate);
