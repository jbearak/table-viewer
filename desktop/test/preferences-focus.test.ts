import { describe, expect, it, vi } from 'vitest';
import { focus_preferences_target } from '../renderer/preferences-focus';

describe('Preferences focus targets', () => {
    it('centers and focuses the maximum file-size setting', () => {
        const scrollIntoView = vi.fn();
        const focus = vi.fn();
        const element = { scrollIntoView, focus } as unknown as HTMLElement;

        focus_preferences_target('maxFileSizeMiB', { maxFileSizeMiB: element });

        expect(scrollIntoView).toHaveBeenCalledWith({
            block: 'center',
            inline: 'nearest',
        });
        expect(focus).toHaveBeenCalledWith({ preventScroll: true });
        expect(scrollIntoView.mock.invocationCallOrder[0])
            .toBeLessThan(focus.mock.invocationCallOrder[0]);
    });

    it('ignores a target whose element is unavailable', () => {
        expect(() => focus_preferences_target('maxFileSizeMiB', {})).not.toThrow();
    });
});
