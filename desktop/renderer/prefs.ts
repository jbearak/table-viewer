// Preferences window renderer: edits the desktop settings file through
// prefs-preload.ts. Changes persist immediately and notify ConfigPort
// listeners in the main process (font changes propagate live to every window,
// this one included; the other settings apply on the next file load).
import type { PrefsApi } from '../preload/prefs-preload';
import type { DesktopSettings } from '../main/desktop-config';
import type { ThemePayload, ThemeSetting, ThemeKind } from '../main/theme';

const prefs_api = (window as unknown as { prefsApi: PrefsApi }).prefsApi;

const font_family = document.getElementById('fontFamily') as HTMLInputElement;
const font_size = document.getElementById('fontSize') as HTMLInputElement;
const theme = document.getElementById('theme') as HTMLSelectElement;
const color_theme = document.getElementById('colorTheme') as HTMLSelectElement;
const tab_orientation = document.getElementById('tabOrientation') as HTMLSelectElement;
const csv_max_rows = document.getElementById('csvMaxRows') as HTMLInputElement;
const max_file_size = document.getElementById('maxFileSizeMiB') as HTMLInputElement;
const status = document.getElementById('status') as HTMLDivElement;

/** The kind the color-theme select is currently offering themes for. Tracked
 *  from the theme payload rather than from the settings, because under
 *  Appearance=System the answer is the OS's and can change while this window is
 *  open — the payload is the one stream that already carries that. */
let current_kind: ThemeKind = 'light';

function apply_theme(payload: ThemePayload): void {
    const vars = payload.variables;
    const root = document.documentElement;
    root.style.setProperty('--prefs-bg', vars['--vscode-editor-background']);
    root.style.setProperty('--prefs-fg', vars['--vscode-foreground']);
    root.style.setProperty('--prefs-border', vars['--vscode-input-border']);
    root.style.setProperty('--prefs-input-bg', vars['--vscode-input-background']);
    root.style.setProperty('--prefs-muted', vars['--vscode-descriptionForeground']);
    root.style.colorScheme = payload.kind;
    populate_color_themes(payload);
}

/**
 * Retarget the color-theme select at whatever mode is now resolved.
 *
 * Driven off the theme payload — which arrives on startup via get_theme() and on
 * every appearance or palette change — rather than off DesktopSettings, so the
 * dynamic behavior falls out for free (an OS light↔dark flip under
 * Appearance=System rebuilds the list live) and only one code path ever owns
 * this element's value.
 */
function populate_color_themes(payload: ThemePayload): void {
    if (payload.kind !== current_kind || color_theme.options.length === 0) {
        current_kind = payload.kind;
        // Stamped on the element, not only kept in `current_kind`, so the change
        // handler can write to the slot matching the list the user actually saw
        // (see the race described there).
        color_theme.dataset.kind = current_kind;
        color_theme.replaceChildren(
            ...prefs_api.themes_for_kind(current_kind).map((theme_option) => {
                const option = document.createElement('option');
                option.value = theme_option.id;
                option.textContent = theme_option.label;
                return option;
            }),
        );
    }
    color_theme.value = payload.themeId;
}

/** The font settings style the whole app, so this window follows them too. */
function apply_fonts(settings: DesktopSettings): void {
    const root = document.documentElement;
    const family = settings.fontFamily.trim();
    if (family) root.style.setProperty('--prefs-font-family', family);
    else root.style.removeProperty('--prefs-font-family');
    root.style.setProperty('--prefs-font-size', `${settings.fontSize}px`);
}

function populate(settings: DesktopSettings): void {
    font_family.value = settings.fontFamily;
    font_size.value = String(settings.fontSize);
    theme.value = settings.theme;
    // Deliberately not colorTheme: it is a view of the live theme payload (see
    // populate_color_themes), so writing it from settings here would fight that.
    tab_orientation.value = settings.tabOrientation;
    csv_max_rows.value = String(settings.csvMaxRows);
    max_file_size.value = String(settings.maxFileSizeMiB);
    apply_fonts(settings);
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
// The select offers only the three valid values, and the store sanitizes anyway.
theme.addEventListener('change', () => save({ theme: theme.value as ThemeSetting }));
// Which slot this writes depends on the mode the list is currently showing —
// that is the whole meaning of this control.
//
// Read from the element's own dataset rather than from `current_kind`, which is
// module state sampled at *dispatch* time: a theme payload with a flipped kind
// (an OS light↔dark flip under Appearance=System) landing between the user
// committing a selection and this event firing would rebuild the list, flip
// `current_kind`, and make this write e.g. `solarized-light` into darkThemeId —
// which `sanitize_theme_id` silently rejects, so the click appears to do nothing.
color_theme.addEventListener('change', () => {
    save(color_theme.dataset.kind === 'dark'
        ? { darkThemeId: color_theme.value as DesktopSettings['darkThemeId'] }
        : { lightThemeId: color_theme.value as DesktopSettings['lightThemeId'] });
});
tab_orientation.addEventListener('change', () => {
    save({ tabOrientation: tab_orientation.value === 'vertical' ? 'vertical' : 'horizontal' });
});
function numeric_value(input: HTMLInputElement): number | null {
    if (input.value.trim() === '') return null;
    const value = Number(input.value);
    return Number.isFinite(value) ? value : null;
}
font_size.addEventListener('change', () => {
    const value = numeric_value(font_size);
    // The store clamps out-of-range sizes; repopulating shows the clamped value.
    if (value !== null) save({ fontSize: value });
    else void prefs_api.get_settings().then(populate);
});
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
prefs_api.on_settings_changed(apply_fonts);
void prefs_api.get_settings().then(populate);
