import { describe, expect, it } from 'vitest';
import { WRAP_HYSTERESIS_PX, should_wrap } from '../webview/use-toolbar-wrap';

describe('toolbar wrap policy', () => {
    const parts = { lead_px: 90, chips_px: 240, actions_px: 260 };

    it('keeps actions reachable by wrapping chips when all regions do not fit', () => {
        expect(should_wrap(parts, 600, 8, false)).toBe(true);
        expect(should_wrap(parts, 610, 8, false)).toBe(false);
    });

    it('uses hysteresis before unwrapping', () => {
        const needed = parts.lead_px + parts.chips_px + parts.actions_px + 16;
        expect(should_wrap(parts, needed + WRAP_HYSTERESIS_PX - 1, 8, true)).toBe(true);
        expect(should_wrap(parts, needed + WRAP_HYSTERESIS_PX, 8, true)).toBe(false);
    });

    it('never wraps when no chip strip exists', () => {
        expect(should_wrap({ ...parts, chips_px: 0 }, 100, 8, false)).toBe(false);
    });
});
