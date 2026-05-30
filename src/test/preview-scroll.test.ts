import { describe, expect, it, vi } from 'vitest';
import { scroll_preview_to_row } from '../webview/preview-scroll';

describe('scroll_preview_to_row', () => {
    // Regression (#19): the Glide rebuild called scrollTo without vAlign, so the
    // grid only scrolled once the synced row left the viewport — the preview
    // appeared frozen until ~a full screen of rows had passed. The vAlign:'start'
    // below top-aligns the row so the preview tracks the editor line-for-line,
    // like revealRange(AtTop) does in the preview→editor direction.
    it('scrolls the grid to the row, aligned to the top of the viewport', () => {
        const scrollTo = vi.fn();
        scroll_preview_to_row({ scrollTo }, 33);
        expect(scrollTo).toHaveBeenCalledWith(0, 33, 'vertical', 0, 0, { vAlign: 'start' });
    });

    it('no-ops when the grid is not mounted yet', () => {
        expect(() => scroll_preview_to_row(null, 5)).not.toThrow();
        expect(() => scroll_preview_to_row(undefined, 5)).not.toThrow();
    });
});
