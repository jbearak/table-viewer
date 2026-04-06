import { describe, expect, it } from 'vitest';
import { get_preview_reveal_target_line } from '../preview-scroll-sync';

describe('get_preview_reveal_target_line', () => {
    it('returns no work when the target line is already at the top of the viewport', () => {
        expect(
            get_preview_reveal_target_line(
                12,
                { top_line: 12 },
                100
            )
        ).toBeNull();
    });

    it('adds a fixed compensation so the requested line becomes the top line', () => {
        expect(
            get_preview_reveal_target_line(
                20,
                { top_line: 10 },
                100
            )
        ).toBe(25);
    });

    it('works without a visible window', () => {
        expect(
            get_preview_reveal_target_line(
                7,
                null,
                100
            )
        ).toBe(12);
    });

    it('clamps at the end of the document', () => {
        expect(
            get_preview_reveal_target_line(
                95,
                { top_line: 60 },
                100
            )
        ).toBe(99);
    });
});
