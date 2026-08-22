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
    // Checked as typed. A filename may legitimately begin or end with a space,
    // so trimming before the check asks about a different file than the one
    // that will be opened — `trim()` here is only for the emptiness test.
    const path = inputs[side].value;
    if (path.trim() === '') {
        checks[side] = undefined;
        render();
        return;
    }
    const result = await compare_api.check_path(path);
    if (check_tokens[side] !== token) return;
    checks[side] = result;
    render();
}

/**
 * How long a field must sit unchanged before its path is checked.
 *
 * Without it, every prefix of a path the user is typing out is a real path
 * that really does not exist, so the field accused them of a missing file
 * once per keystroke all the way to the last character. Blur checks
 * immediately, so nothing waits on this timer to be told the truth.
 */
const CHECK_DEBOUNCE_MS = 350;
const check_timers: Record<Side, ReturnType<typeof setTimeout> | undefined> = {
    original: undefined,
    modified: undefined,
};

function schedule_check(side: Side): void {
    if (check_timers[side] !== undefined) clearTimeout(check_timers[side]);
    check_timers[side] = setTimeout(() => {
        check_timers[side] = undefined;
        void check_side(side);
    }, CHECK_DEBOUNCE_MS);
}

/**
 * Fill in the field's unique completion, if it has one, and settle its verdict.
 *
 * Loops because completing can reveal another completion — `/p/t/me` may
 * complete to `/p/to/merp.xlsx` in one step or to a directory in two — and
 * stops as soon as a check offers none. Bounded rather than `while (true)`: the
 * checks come from another process, and a filesystem that kept offering
 * completions must not hang the dialog.
 */
const MAX_COMPLETION_STEPS = 8;

async function complete_and_check(side: Side): Promise<void> {
    for (let step = 0; step < MAX_COMPLETION_STEPS; step++) {
        await check_side(side);
        const completion = checks[side]?.completion;
        if (completion === undefined || completion === inputs[side].value) return;
        inputs[side].value = completion;
        checks[side] = undefined;
        render();
    }
    await check_side(side);
}

for (const side of ['original', 'modified'] as const) {
    inputs[side].addEventListener('input', () => {
        // Drop the stale verdict immediately, so the button cannot stay enabled
        // on the strength of a check of the previous text. Retire the in-flight
        // token too: its answer describes text that is no longer there.
        checks[side] = undefined;
        check_tokens[side]++;
        render();
        schedule_check(side);
    });
    // Leaving the field ends the typing, so the verdict is owed now rather
    // than a debounce later — and with it, the completion.
    inputs[side].addEventListener('blur', () => {
        if (check_timers[side] !== undefined) {
            clearTimeout(check_timers[side]);
            check_timers[side] = undefined;
        }
        void complete_and_check(side);
    });
}

const browse = async (side: Side): Promise<void> => {
    // Start in the folder the other side already names, falling back to this
    // side's own text. Browsing for the second file of a pair almost always
    // means browsing the folder the first one came from.
    const other: Side = side === 'original' ? 'modified' : 'original';
    const near = inputs[other].value.trim() !== ''
        ? inputs[other].value
        : inputs[side].value;
    const chosen = await compare_api.browse(side, near.trim() === '' ? undefined : near);
    if (chosen === undefined) return;
    inputs[side].value = chosen;
    if (check_timers[side] !== undefined) {
        clearTimeout(check_timers[side]);
        check_timers[side] = undefined;
    }
    // Cleared before the check, exactly as the input handler does. Leaving the
    // previous path's verdict standing kept Compare enabled while the new path
    // was still being checked, so a click in that window submitted the new
    // selection on the strength of the old one's answer.
    checks[side] = undefined;
    render();
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
    // The verdicts move with their paths, but a check still in flight does not:
    // it would land on whichever side its token names, which is now the other
    // path's. Retiring both tokens drops those answers on arrival.
    check_tokens.original++;
    check_tokens.modified++;
    // A side whose verdict had not arrived yet has nothing to swap, so re-ask
    // for it. Sides that already answered are left alone rather than re-checked,
    // which would flash the fields empty for no reason.
    const pending: Side[] = (['original', 'modified'] as const)
        .filter((side) => checks[side] === undefined && inputs[side].value.trim() !== '');
    render();
    for (const side of pending) void check_side(side);
});

compare_button.addEventListener('click', () => {
    if (compare_button.disabled) return;
    void (async () => {
        // Compare finishes the paths first, for the same reason blur does: the
        // user may have typed enough to be unambiguous without typing the last
        // letter, and refusing that is the complaint this answers. A side that
        // completes into something unusable fails the check below and reports
        // itself rather than being submitted.
        await Promise.all((['original', 'modified'] as const)
            .filter((side) => checks[side]?.completion !== undefined)
            .map((side) => complete_and_check(side)));
        if (compare_button.disabled) return;
        const result = await compare_api.submit({
            // Submitted as typed, for the same reason `check_side` checks as
            // typed: the path that was validated has to be the path opened.
            originalPath: inputs.original.value,
            modifiedPath: inputs.modified.value,
        });
        // Accepted means the window is opening and this dialog is closing, so
        // there is nothing left to render. A rejection means main re-checked
        // and found a file gone or unreadable since the dialog last asked;
        // adopting those verdicts is what puts the error under the field and
        // takes Compare out of the enabled state the stale check left it in.
        if (result.accepted || !result.checks) return;
        checks.original = result.checks.original;
        checks.modified = result.checks.modified;
        render();
    })();
});

cancel_button.addEventListener('click', () => compare_api.cancel());

document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
        compare_api.cancel();
        return;
    }
    // Enter submits from either field, the way a native dialog does — but only
    // when there is something to submit, and only from the fields. A focused
    // Cancel, Swap or Browse gets Enter natively; submitting as well would
    // both cancel and compare on one keypress.
    const focused = document.activeElement;
    const from_field = focused === inputs.original || focused === inputs.modified;
    if (event.key === 'Enter' && from_field && !compare_button.disabled) {
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
    root.style.setProperty(
        '--compare-button-hover-bg',
        vars['--vscode-button-secondaryHoverBackground'],
    );
    root.style.setProperty('--compare-accent', vars['--vscode-button-background']);
    root.style.setProperty('--compare-accent-hover', vars['--vscode-button-hoverBackground']);
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
