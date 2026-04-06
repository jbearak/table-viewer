import { describe, expect, it } from 'vitest';
import { get_preview_reveal_target_line } from '../preview-scroll-sync';

describe('get_preview_reveal_target_line', () => {
    it('returns null when the reveal target already matches the viewport top', () => {
        // source_line 17 → reveal target = 17 - 5 = 12
        // viewport top is already 12 → no work needed
        expect(
            get_preview_reveal_target_line(
                17,
                { top_line: 12 },
                100
            )
        ).toBeNull();
    });

    it('subtracts padding so the source line appears below the top with context above', () => {
        // source_line 20 → reveal target = 20 - 5 = 15
        expect(
            get_preview_reveal_target_line(
                20,
                { top_line: 10 },
                100
            )
        ).toBe(15);
    });

    it('works without a visible window', () => {
        // source_line 7 → reveal target = 7 - 5 = 2
        expect(
            get_preview_reveal_target_line(
                7,
                null,
                100
            )
        ).toBe(2);
    });

    it('clamps at the start of the document', () => {
        // source_line 2 → reveal target = 2 - 5 = -3 → clamped to 0
        expect(
            get_preview_reveal_target_line(
                2,
                { top_line: 10 },
                100
            )
        ).toBe(0);
    });

    it('clamps at the end of the document', () => {
        expect(
            get_preview_reveal_target_line(
                95,
                { top_line: 60 },
                100
            )
        ).toBe(90);
    });

    it('returns null for empty document', () => {
        expect(
            get_preview_reveal_target_line(0, null, 0)
        ).toBeNull();
    });
});
