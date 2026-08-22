// Renderer for the Compare Files dialog (File → Compare Files…). Collects two
// paths, reports what is wrong with either of them, and hands the pair to the
// main process, which opens the read-only compare window.
//
// The decisions — whether Compare is offerable, what it should be called, and
// which caveat to show — live in desktop/shared/compare-dialog-model.ts, so
// they are testable without a DOM. This file is wiring.
import type { CompareApi } from '../preload/compare-preload';
import type { DesktopSettings } from '../main/desktop-config';
import type { ThemePayload } from '../main/theme';
import type { ComparePathCheck } from '../shared/ipc';
import { SYSTEM_FONT, font_family_with_fallback } from '../main/theme-palette';
import { install_titlebar_from_api } from '../shared/titlebar';
import {
    dialog_state,
    path_error,
    path_state,
    type ComparePathState,
} from '../shared/compare-dialog-model';

const compare_api = (window as unknown as { compareApi: CompareApi }).compareApi;

type Side = 'original' | 'modified';

const element = <T extends HTMLElement>(id: string): T =>
    document.getElementById(id) as T;

const inputs: Record<Side, HTMLInputElement> = {
    original: element<HTMLInputElement>('originalPath'),
    modified: element<HTMLInputElement>('modifiedPath'),
};
const errors: Record<Side, HTMLElement> = {
    original: element('originalError'),
    modified: element('modifiedError'),
};
const warning = element('warning');
const compare_button = element<HTMLButtonElement>('compare');
const cancel_button = element<HTMLButtonElement>('cancel');
const swap_button = element<HTMLButtonElement>('swap');

/** The last check answered for each side's current text. Cleared on every
 *  keystroke so a stale verdict can never gate the button. */
const checks: Record<Side, ComparePathCheck | undefined> = {
    original: undefined,
    modified: undefined,
};
/** Guards against an out-of-order check: only the newest request per side may
 *  write its answer, or a slow check of an old path overwrites a new one. */
const check_tokens: Record<Side, number> = { original: 0, modified: 0 };

function state_of(side: Side): ComparePathState {
    return path_state(inputs[side].value, checks[side]);
}

function render(): void {
    const states = { original: state_of('original'), modified: state_of('modified') };
    for (const side of ['original', 'modified'] as const) {
        const message = path_error(states[side]);
        errors[side].textContent = message ?? '';
        errors[side].hidden = message === undefined;
        inputs[side].classList.toggle('invalid', message !== undefined);
    }
    const dialog = dialog_state(states.original, states.modified);
    compare_button.disabled = !dialog.canCompare;
    compare_button.textContent = dialog.compareLabel;
    warning.textContent = dialog.warning ?? '';
    warning.hidden = dialog.warning === undefined;
}

async function check_side(side: Side): Promise<void> {
    const token = ++check_tokens[side];
    const path = inputs[side].value.trim();
    if (path === '') {
        checks[side] = undefined;
        render();
        return;
    }
    const result = await compare_api.check_path(path);
    if (check_tokens[side] !== token) return;
    checks[side] = result;
    render();
}

for (const side of ['original', 'modified'] as const) {
    inputs[side].addEventListener('input', () => {
        // Drop the stale verdict immediately, so the button cannot stay enabled
        // on the strength of a check of the previous text.
        checks[side] = undefined;
        render();
        void check_side(side);
    });
}

const browse = async (side: Side): Promise<void> => {
    const chosen = await compare_api.browse(side);
    if (chosen === undefined) return;
    inputs[side].value = chosen;
    await check_side(side);
};

element('browseOriginal').addEventListener('click', () => void browse('original'));
element('browseModified').addEventListener('click', () => void browse('modified'));

swap_button.addEventListener('click', () => {
    const original = inputs.original.value;
    inputs.original.value = inputs.modified.value;
    inputs.modified.value = original;
    const original_check = checks.original;
    checks.original = checks.modified;
    checks.modified = original_check;
    // Both sides already have verdicts; swapping them is enough, and re-checking
    // would flash the fields empty for no reason.
    render();
});

compare_button.addEventListener('click', () => {
    if (compare_button.disabled) return;
    compare_api.submit({
        originalPath: inputs.original.value.trim(),
        modifiedPath: inputs.modified.value.trim(),
    });
});

cancel_button.addEventListener('click', () => compare_api.cancel());

document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
        compare_api.cancel();
        return;
    }
    // Enter submits from either field, the way a native dialog does — but only
    // when there is something to submit.
    if (event.key === 'Enter' && !compare_button.disabled) {
        compare_button.click();
    }
});

function apply_theme(payload: ThemePayload): void {
    const vars = payload.variables;
    const root = document.documentElement;
    root.style.setProperty('--compare-bg', vars['--vscode-editor-background']);
    root.style.setProperty('--compare-fg', vars['--vscode-foreground']);
    root.style.setProperty('--compare-border', vars['--vscode-input-border']);
    root.style.setProperty('--compare-input-bg', vars['--vscode-input-background']);
    root.style.setProperty('--compare-muted', vars['--vscode-descriptionForeground']);
    root.style.setProperty('--compare-foot-bg', vars['--vscode-editorGroupHeader-tabsBackground']);
    root.style.setProperty('--compare-button-bg', vars['--vscode-button-secondaryBackground']);
    root.style.setProperty('--compare-accent', vars['--vscode-button-background']);
    root.style.setProperty('--compare-accent-fg', vars['--vscode-button-foreground']);
    root.style.setProperty('--compare-error', vars['--vscode-errorForeground']);
    root.style.setProperty('--compare-warning', vars['--vscode-editorWarning-foreground']);
    root.style.setProperty('--compare-warning-bg', vars['--vscode-editorWarning-background']);
    // No error *background* role exists, so it is composed the way the app's
    // other tints are: the foreground at the banner alpha.
    root.style.setProperty(
        '--compare-error-bg',
        `${vars['--vscode-errorForeground']}33`,
    );
    root.style.colorScheme = payload.kind;
}

/** The font preference styles the whole app, so this window follows it too. */
function apply_settings(settings: DesktopSettings): void {
    const root = document.documentElement;
    root.style.setProperty(
        '--compare-font-family',
        font_family_with_fallback(settings.fontFamily, SYSTEM_FONT),
    );
    root.style.setProperty('--compare-font-size', `${settings.fontSize}px`);
}

compare_api.on_theme_changed(apply_theme);
compare_api.on_settings_changed(apply_settings);
apply_theme(compare_api.get_theme());
void compare_api.get_settings().then(apply_settings);

// macOS themed title bar. No band color and no rule: this window has no toolbar
// for the strip to continue, so it takes the window's own background.
install_titlebar_from_api(document, compare_api, { background: 'var(--compare-bg)' });

render();
inputs.original.focus();
