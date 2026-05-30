// Editor → preview scroll sync for the Glide canvas grid.
//
// The host posts `scrollToRow` as the text editor scrolls; we align that row to
// the TOP of the preview viewport, mirroring the preview→editor direction's
// editor.revealRange(…, AtTop). Glide's scrollTo with no vAlign only scrolls the
// minimum to keep the row visible, so before this the preview stayed frozen
// until the synced row fell off the bottom of the viewport (the #19 regression).

/** The slice of Glide's DataEditorRef we drive; structural so tests can pass a spy. */
export interface ScrollableGrid {
    scrollTo(
        col: number,
        row: number,
        dir?: 'horizontal' | 'vertical' | 'both',
        paddingX?: number,
        paddingY?: number,
        options?: { vAlign?: 'start' | 'center' | 'end' },
    ): void;
}

export function scroll_preview_to_row(
    grid: ScrollableGrid | null | undefined,
    row: number,
): void {
    grid?.scrollTo(0, row, 'vertical', 0, 0, { vAlign: 'start' });
}
