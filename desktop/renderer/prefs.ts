// Preferences window renderer: edits the desktop settings file through
// prefs-preload.ts. There is no Save button — every control writes as it is used
// (selects on change, text fields on a short debounce, and on the way out of the
// field or the window), and each write notifies ConfigPort listeners in the main
// process (font changes propagate live to every window, this one included; the
// other settings apply on the next file load).
import type { PrefsApi } from '../preload/prefs-preload';
import type { DesktopSettings } from '../main/desktop-config';
import type { ThemePayload, ThemeSetting, ThemeKind } from '../main/theme';
// A pure module (no electron import), so the renderer bundle can share the one
// definition of the usable size range with the main process.
import {
    MIN_WINDOW_HEIGHT,
    MIN_WINDOW_WIDTH,
    sanitize_new_window_size_mode,
} from '../main/window-geometry';
import { SYSTEM_FONT, font_family_with_fallback } from '../main/theme-palette';
import { install_titlebar_from_api } from '../shared/titlebar';
import {
    focus_preferences_target,
    type PreferencesFocusTargets,
} from './preferences-focus';

const prefs_api = (window as unknown as { prefsApi: PrefsApi }).prefsApi;

const font_family = document.getElementById('fontFamily') as HTMLInputElement;
const font_size = document.getElementById('fontSize') as HTMLInputElement;
const theme = document.getElementById('theme') as HTMLSelectElement;
const color_theme = document.getElementById('colorTheme') as HTMLSelectElement;
const tab_orientation = document.getElementById('tabOrientation') as HTMLSelectElement;
const new_window_size = document.getElementById('newWindowSize') as HTMLSelectElement;
const new_window_size_hint = document.getElementById('newWindowSizeHint') as HTMLSpanElement;
const window_width = document.getElementById('windowWidth') as HTMLInputElement;
const window_height = document.getElementById('windowHeight') as HTMLInputElement;
const csv_max_rows = document.getElementById('csvMaxRows') as HTMLInputElement;
const max_file_size = document.getElementById('maxFileSizeMiB') as HTMLInputElement;
const diff_on_by_default = document.getElementById('diffOnByDefault') as HTMLInputElement;
const automatically_check_for_updates = document.getElementById(
    'automaticallyCheckForUpdates',
) as HTMLInputElement;
const focus_targets: PreferencesFocusTargets = {
    maxFileSizeMiB: max_file_size,
    csvMaxRows: csv_max_rows,
};

/** The kind the color-theme select is currently offering themes for. Tracked
 *  from the theme payload rather than from the settings, because under
 *  Color scheme=System the answer is the OS's and can change while this window is
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
 * Color scheme=System rebuilds the list live) and only one code path ever owns
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
    root.style.setProperty(
        '--prefs-font-family',
        font_family_with_fallback(settings.fontFamily, SYSTEM_FONT),
    );
    root.style.setProperty('--prefs-font-size', `${settings.fontSize}px`);
}

/** Kept to a line each: the window is a fixed height and every field below
 *  this one pays for a hint that wraps. */
const SIZE_HINTS: Record<DesktopSettings['newWindowSize'], string> = {
    'match-last': 'Tracks the last window you resized.',
    fixed: 'Always opens at the size below.',
};

/** The fields holding keystrokes the store has not answered for yet. Marked by
 *  typing, cleared by a value arriving from the store or by a commit — after
 *  which the store's answer, clamping and all, is what should be on screen. */
const mid_edit = new WeakSet<HTMLInputElement>();

/** The stored value each field is showing, by element. */
const baselines = new WeakMap<HTMLInputElement, string>();

/**
 * Write a stored value into a text input, unless the user is partway through
 * typing in it.
 *
 * Every one of these fields saves while it is being typed in (see `queue`), and
 * each save echoes the stored settings back here. Overwriting the field mid-word
 * with the value the store just clamped — or, under `match-last`, with a size a
 * viewer window changed on its own — would be the one way this window fights the
 * user. What the store settled on still shows the moment the field is committed
 * or left, both of which mark it clean again.
 *
 * Being *in* the field is not enough to skip: at startup the boxes are empty and
 * one of them can already have the caret, and skipping there would leave the
 * field blank while the baseline said otherwise — which reads as an edit, and
 * would clear a configured font on the way out without anyone touching it.
 */
function set_input(input: HTMLInputElement, value: string): void {
    // Recorded even when the write is skipped: this is the stored value the field
    // is an edit *of*, which is what tells typing apart from retyping (see
    // `is_mid_edit`), and a field being typed in is exactly when that is asked.
    baselines.set(input, value);
    if (document.activeElement === input && mid_edit.has(input)) return;
    input.value = value;
    mid_edit.delete(input);
}

/**
 * Is this field's text a value in progress rather than a value?
 *
 * Shorter than the stored value it started from means digits (or characters) have
 * been taken away — backspacing 13 to 1, or 24 to 2. Nobody means 1pt by that;
 * they mean they are partway through typing something else. So it is not saved
 * while it is being typed, only if the user leaves the field or closes the window
 * still standing on it, which the flush paths handle.
 *
 * Deliberately a length test and not a range test: it is what catches the cases
 * the field's own min/max cannot, like backspacing a 1000000-row limit to 100000,
 * where every prefix is a perfectly legal setting.
 */
function is_mid_edit(input: HTMLInputElement): boolean {
    return input.value.trim().length < (baselines.get(input) ?? '').length;
}

/**
 * Show the size fields as the mode makes them: editable under `fixed`, and
 * under `match-last` a read-only readout of the size the app is tracking.
 */
function apply_window_size(settings: DesktopSettings): void {
    const fixed = settings.newWindowSize === 'fixed';
    new_window_size.value = settings.newWindowSize;
    new_window_size_hint.textContent = SIZE_HINTS[settings.newWindowSize];
    for (const [input, value] of [
        [window_width, settings.windowWidth],
        [window_height, settings.windowHeight],
    ] as const) {
        input.disabled = !fixed;
        set_input(input, String(value));
    }
}

function populate(settings: DesktopSettings): void {
    set_input(font_family, settings.fontFamily);
    set_input(font_size, String(settings.fontSize));
    theme.value = settings.theme;
    // Deliberately not colorTheme: it is a view of the live theme payload (see
    // populate_color_themes), so writing it from settings here would fight that.
    tab_orientation.value = settings.tabOrientation;
    set_input(csv_max_rows, String(settings.csvMaxRows));
    set_input(max_file_size, String(settings.maxFileSizeMiB));
    diff_on_by_default.checked = settings.diffOnByDefault;
    automatically_check_for_updates.checked = settings.automaticallyCheckForUpdates;
    apply_window_size(settings);
    apply_fonts(settings);
}

function save(partial: Partial<DesktopSettings>): void {
    // A rejection means the settings file could not be written. Nothing useful to
    // do about it here, but it must not surface as an unhandled rejection, and the
    // fields are left showing what the user typed rather than a lie about it.
    prefs_api.set_settings(partial).then(populate, (error: unknown) => {
        console.error('failed to save preferences', error);
    });
}

/** Put the stored settings back on screen. Rejection is handled for the same
 *  reason as in `save`: `void` on a promise silences the lint rule, not the
 *  unhandled rejection. */
function repopulate(): void {
    prefs_api.get_settings().then(populate, (error: unknown) => {
        console.error('failed to read preferences', error);
    });
}

/**
 * How long a text field sits unchanged before its value is saved.
 *
 * There is no Save button and no Enter to press: typing is the commit. The wait
 * only exists so a half-typed number ("1" on the way to "14") is not saved,
 * clamped, and applied to the app font for a blink. Every path out of a field —
 * Enter, blur, closing the window — flushes early, so it is never the thing
 * standing between a keystroke and the setting taking effect.
 */
const SAVE_DEBOUNCE_MS = 500;

let pending: Partial<DesktopSettings> = {};
let save_timer: ReturnType<typeof setTimeout> | undefined;

/** Save `partial` once the typing stops. Merged rather than queued, so a burst
 *  of keystrokes in two fields still costs one write. */
function queue(partial: Partial<DesktopSettings>): void {
    pending = { ...pending, ...partial };
    if (save_timer) clearTimeout(save_timer);
    save_timer = setTimeout(flush, SAVE_DEBOUNCE_MS);
}

/** Claim the queued patch and cancel the debounce; `null` if nothing is waiting.
 *  Split out from `flush` because the unload path has to write it differently. */
function take_pending(): Partial<DesktopSettings> | null {
    if (save_timer) clearTimeout(save_timer);
    save_timer = undefined;
    if (Object.keys(pending).length === 0) return null;
    const partial = pending;
    pending = {};
    return partial;
}

/** Write whatever is waiting, now. Safe to call with nothing pending. */
function flush(): void {
    const partial = take_pending();
    if (partial) save(partial);
}

/** Forget a field's queued value, and the debounce with it if that was the only
 *  thing waiting. What makes clearing a field mean "I am retyping this" rather
 *  than "save the prefix I just deleted": the keystrokes on the way to empty
 *  each queued a value, and the empty one has to take them back. */
function discard(key: keyof DesktopSettings): void {
    delete pending[key];
    if (Object.keys(pending).length === 0 && save_timer) {
        clearTimeout(save_timer);
        save_timer = undefined;
    }
}

/** A text field, and how to read a settings patch out of it. `null` means the
 *  text is not a usable value yet — empty, or not a number — which is an
 *  ordinary state to pass through while typing, so it is not saved. */
interface TextField {
    input: HTMLInputElement;
    /** The setting this field owns, so a mid-edit value can be taken back. */
    key: keyof DesktopSettings;
    read(): Partial<DesktopSettings> | null;
    /** An extra "the user could have meant this" test for saving while typing,
     *  beyond the field's own validity. Omitted where validity is the whole
     *  story. */
    ready?(): boolean;
}

/** A string with letters of every width, so two fonts that differ at all differ
 *  in what it measures. */
const FONT_PROBE = 'mmmmmmmmmmwwwwwwwwwwiiiiiiiiiil0O';
/** Three unlike generics, because a name is only detectable against a fallback it
 *  does not itself resolve to — "monospace" measured against monospace is the
 *  same font. Only one of the three has to disagree. */
const FONT_FALLBACKS = ['monospace', 'serif', 'sans-serif'];
const font_probe_context = document.createElement('canvas').getContext('2d');

/**
 * Does this font-family text name something the system can actually draw?
 *
 * There is no font list to consult, so this measures: text set in `<text>,
 * <generic>` is wider or narrower than the same text in `<generic>` alone only if
 * something in `<text>` resolved to a real face. It is also why malformed CSS
 * reads as unavailable — assigning it to `context.font` is ignored, so the two
 * measurements come out identical, which is the safe answer anyway.
 *
 * Used only to decide whether to apply a font *while it is being typed*: every
 * prefix of a font name is a name the system does not have, and applying those
 * drops the whole app to the default font letter by letter. An unrecognized name
 * is still saved when the user leaves the field or closes the window — they may
 * know something this test does not.
 */
function font_is_available(family: string): boolean {
    const name = family.trim();
    // Empty is the documented way to ask for the system default.
    if (!name || !font_probe_context) return true;
    const context = font_probe_context;
    return FONT_FALLBACKS.some((fallback) => {
        context.font = `16px ${fallback}`;
        const fallback_width = context.measureText(FONT_PROBE).width;
        context.font = `16px ${name}, ${fallback}`;
        return context.measureText(FONT_PROBE).width !== fallback_width;
    });
}

function numeric_value(input: HTMLInputElement): number | null {
    if (input.value.trim() === '') return null;
    const value = Number(input.value);
    return Number.isFinite(value) ? value : null;
}

/** The store clamps out-of-range numbers; repopulating on blur shows what it
 *  settled on. */
function numeric_field(
    input: HTMLInputElement,
    key: 'fontSize' | 'windowWidth' | 'windowHeight' | 'csvMaxRows' | 'maxFileSizeMiB',
): TextField {
    return {
        input,
        key,
        read: () => {
            const value = numeric_value(input);
            return value === null ? null : { [key]: value };
        },
    };
}

const TEXT_FIELDS: TextField[] = [
    {
        input: font_family,
        key: 'fontFamily',
        // The empty string is a real value here (it means "system default"), so
        // this one never reads as unusable.
        read: () => ({ fontFamily: font_family.value }),
        ready: () => font_is_available(font_family.value),
    },
    numeric_field(font_size, 'fontSize'),
    // Only reachable under `fixed` — the inputs are disabled otherwise.
    numeric_field(window_width, 'windowWidth'),
    numeric_field(window_height, 'windowHeight'),
    numeric_field(csv_max_rows, 'csvMaxRows'),
    numeric_field(max_file_size, 'maxFileSizeMiB'),
];

for (const field of TEXT_FIELDS) {
    // Saving while typing means saving what the user is only passing through, and
    // the settings are applied to the app as they are written — so a half-typed
    // "1" shrinks everything to the 8px minimum, and every prefix of a font name
    // drops it to the default face. Three tests keep those out: the field's own
    // min/max/step (`checkValidity`), "shorter than what was there"
    // (`is_mid_edit`), and the field's own `ready`. Whatever fails them is not
    // written *yet* — it still saves on Enter, on leaving the field, and on
    // closing the window, where the user has stopped typing and means it.
    field.input.addEventListener('input', () => {
        mid_edit.add(field.input);
        const settled = field.input.checkValidity()
            && !is_mid_edit(field.input)
            && (field.ready?.() ?? true);
        const patch = settled ? field.read() : null;
        if (patch) queue(patch);
        else discard(field.key);
    });
    // `change` is Enter (or a stepper click) — the user asking for it now.
    field.input.addEventListener('change', () => commit(field));
    // Leaving the field is the other "now". Also the moment the value can be
    // written back: a rejected or clamped number must not be left on screen
    // looking accepted, and an unusable one has to be replaced by what is stored.
    field.input.addEventListener('blur', () => commit(field));
}

function commit(field: TextField): void {
    // Clicking or tabbing out of an edited field fires `change` *and* `blur`, both
    // of them before the save can echo anything back. Without this the two would
    // each write the same settings and broadcast them to every window. The
    // baseline is what the field is known to have already asked the store for, so
    // it is also the test for "this commit has happened".
    if (baselines.get(field.input) === field.input.value && !(field.key in pending)) return;

    // Committing is asking the store for this value, so its answer — a clamped
    // number, or the stored value back if this was unusable — is what the field
    // should show, even on Enter, where the caret has not gone anywhere.
    mid_edit.delete(field.input);
    const patch = field.read();
    if (patch) {
        queue(patch);
        baselines.set(field.input, field.input.value);
    }
    // Either way this ends in a populate: a write echoes the stored settings
    // back, and with nothing worth writing the field still has to be reset to
    // them — that is how an empty or garbled entry gets undone.
    const partial = take_pending();
    if (partial) save(partial);
    else repopulate();
}

/** The fields that are showing something other than what is stored, as a patch.
 *  Untouched fields are left out so closing the window with nothing typed is not
 *  a write; so are disabled ones (under `match-last` the size inputs are a
 *  readout, not an edit) and unusable ones, where what is stored should stand. */
function read_edited_fields(): Partial<DesktopSettings> {
    let patch: Partial<DesktopSettings> = {};
    for (const field of TEXT_FIELDS) {
        // No baseline means this field has never been shown a stored value —
        // the window is closing before the first settings load came back. An
        // empty font-family box is a valid patch, so without this that close
        // would wipe a configured font nobody touched.
        if (!baselines.has(field.input)) continue;
        if (field.input.disabled || field.input.value === baselines.get(field.input)) continue;
        const field_patch = field.read();
        if (field_patch) patch = { ...patch, ...field_patch };
    }
    return patch;
}

// Switching apps can happen before the debounce fires, and it sends no `blur` to
// the input — the element keeps focus, the window loses it — so the queue would
// sit there until the user came back, or be lost if the app were quit meanwhile.
//
// Only the queue. A value held back as mid-edit is deliberately not committed
// here: leaving the app is not finishing the sentence, and the user may well come
// back to the half-typed font name they left. Closing the window is what settles
// those, below.
window.addEventListener('blur', flush);

/**
 * The last word, on the way out: the fields themselves and not just the queue,
 * because a value held back as mid-edit was never queued, and closing the window
 * standing on it is the user saying they meant it. Field text wins over anything
 * queued for the same setting — it is the later of the two.
 *
 * The write is the blocking one: a promise started here would not settle before
 * the renderer is gone. Once, though — a normal close fires `beforeunload` and
 * then `pagehide`, and neither this nor the settings broadcast should happen
 * twice. Both are listened for because either can be the only one to arrive.
 */
let flushed_on_unload = false;
function flush_on_unload(): void {
    if (flushed_on_unload) return;
    flushed_on_unload = true;
    const partial = { ...take_pending(), ...read_edited_fields() };
    if (Object.keys(partial).length > 0) prefs_api.set_settings_sync(partial);
}
window.addEventListener('beforeunload', flush_on_unload);
window.addEventListener('pagehide', flush_on_unload);

// The select offers only the three valid values, and the store sanitizes anyway.
theme.addEventListener('change', () => save({ theme: theme.value as ThemeSetting }));
// Which slot this writes depends on the mode the list is currently showing —
// that is the whole meaning of this control.
//
// Read from the element's own dataset rather than from `current_kind`, which is
// module state sampled at *dispatch* time: a theme payload with a flipped kind
// (an OS light↔dark flip under Color scheme=System) landing between the user
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
new_window_size.addEventListener('change', () => {
    save({ newWindowSize: sanitize_new_window_size_mode(new_window_size.value) });
});
diff_on_by_default.addEventListener('change', () => {
    save({ diffOnByDefault: diff_on_by_default.checked });
});
automatically_check_for_updates.addEventListener('change', () => {
    save({ automaticallyCheckForUpdates: automatically_check_for_updates.checked });
});

window_width.min = String(MIN_WINDOW_WIDTH);
window_height.min = String(MIN_WINDOW_HEIGHT);

apply_theme(prefs_api.get_theme());
prefs_api.on_theme_changed(apply_theme);
prefs_api.on_focus_target((target) => {
    focus_preferences_target(target, focus_targets);
});
// Not just the fonts: under `match-last` the app itself writes the window size
// as viewer windows are resized, and this window is showing that number.
prefs_api.on_settings_changed((settings) => {
    apply_fonts(settings);
    apply_window_size(settings);
    automatically_check_for_updates.checked = settings.automaticallyCheckForUpdates;
});
repopulate();

// macOS themed title bar. No band color and no rule: this window has no
// toolbar for the strip to continue, so it takes the window's own background
// and reads as one surface.
install_titlebar_from_api(document, prefs_api, { background: 'var(--prefs-bg)' });
