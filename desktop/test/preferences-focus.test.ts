import { describe, expect, it, vi } from 'vitest';
import { focus_preferences_target } from '../renderer/preferences-focus';

describe('Preferences focus targets', () => {
    it.each(['maxFileSizeMiB', 'csvMaxRows'] as const)(
        'centers and focuses the %s setting',
        (target) => {
            const scrollIntoView = vi.fn();
            const focus = vi.fn();
            const element = { scrollIntoView, focus } as unknown as HTMLElement;

            focus_preferences_target(target, { [target]: element });

            expect(scrollIntoView).toHaveBeenCalledWith({
                block: 'center',
                inline: 'nearest',
            });
            expect(focus).toHaveBeenCalledWith({ preventScroll: true });
            expect(scrollIntoView.mock.invocationCallOrder[0])
                .toBeLessThan(focus.mock.invocationCallOrder[0]);
        },
    );

    it('ignores a target whose element is unavailable', () => {
        expect(() => focus_preferences_target('maxFileSizeMiB', {})).not.toThrow();
    });
});
