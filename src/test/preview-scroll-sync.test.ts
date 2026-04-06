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

    it('returns null for empty document', () => {
        expect(
            get_preview_reveal_target_line(0, null, 0)
        ).toBeNull();
    });

    it('subtracts sticky header lines from reveal target', () => {
        // source_line 20 + 5 padding - 1 sticky = 24
        expect(
            get_preview_reveal_target_line(
                20,
                { top_line: 10 },
                100,
                1
            )
        ).toBe(24);
    });

    it('defaults to zero sticky header lines', () => {
        expect(
            get_preview_reveal_target_line(20, { top_line: 10 }, 100)
        ).toBe(25);
        expect(
            get_preview_reveal_target_line(20, { top_line: 10 }, 100, 0)
        ).toBe(25);
    });
});
