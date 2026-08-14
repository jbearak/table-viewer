import type { PreferencesTarget } from '../shared/ipc';

export type PreferencesFocusTargets = Partial<Record<PreferencesTarget, HTMLElement>>;

export function focus_preferences_target(
    target: PreferencesTarget,
    elements: PreferencesFocusTargets,
): void {
    const element = elements[target];
    if (!element) return;
    element.scrollIntoView({ block: 'center', inline: 'nearest' });
    element.focus({ preventScroll: true });
}
