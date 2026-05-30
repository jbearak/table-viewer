# Editor ↔ Preview Scroll Sync Fix

## Problem

When a CSV/TSV file is open in a text editor side-by-side with the Table Viewer
preview, scrolling the **editor** no longer scrolls the **preview** to match.
The preview stays put through the first screenful of editor scrolling and only
jumps once the synced row has fallen far enough — e.g. on a real file the
preview "doesn't even start to scroll till around row 33." The reverse
direction (scrolling the preview moves the editor) still works.

This regressed in **PR #19** ("Rebuild table renderer on Glide canvas grid for
1M-row performance"), which replaced the old DOM `<table>` renderer with the
Glide canvas grid.

## Root Cause

Scroll sync is bidirectional and the two directions use different platform APIs
across the host (node) / webview (browser) bundle boundary:

- **Preview → editor:** the webview posts `visibleRowChanged`; the host maps it
  to a source line and calls `editor.revealRange(range, AtTop)`
  (`src/csv-preview.ts`), top-aligning the line. The pure line math lives in
  `src/preview-scroll-sync.ts` (`get_preview_reveal_target_line`). Unaffected.

- **Editor → preview:** the host posts `scrollToRow`; the webview handles it in
  `src/webview/grid-shell.tsx` and called Glide's
  `grid_ref.scrollTo(0, msg.row, 'vertical')`.

The Glide call omitted the `vAlign` option. Reading Glide 6.0.3's `scrollTo`
implementation (`data-editor.js`), with no `vAlign` the alignment `switch` falls
through and the **entire viewport** stays the acceptable band — so it only
scrolls when the target row is *outside* the viewport, by the minimum amount.
The old DOM renderer always pinned the row to the top
(`scrollTop += row_rect.top − scroller_rect.top`). Hence the preview appears
frozen until the synced row scrolls off the bottom (~one screen of rows).

Programmatic `scrollTo` is an instant jump (no `behavior: 'smooth'`), so the
existing 150 ms bounce-lockout in `src/csv-preview.ts` still covers the echo —
timing was never the issue.

## Design

Restore top-alignment so the editor → preview direction mirrors the
preview → editor direction's `revealRange(AtTop)`.

### New module: `src/webview/preview-scroll.ts`

Extract the Glide scroll command into a named, unit-testable helper. It lives in
the webview bundle (it drives Glide's browser-only `DataEditorRef`), separate
from the host-side, Glide-free `preview-scroll-sync.ts`.

```ts
export interface ScrollableGrid {
    scrollTo(col: number, row: number, dir?: 'horizontal' | 'vertical' | 'both',
             paddingX?: number, paddingY?: number,
             options?: { vAlign?: 'start' | 'center' | 'end' }): void;
}

export function scroll_preview_to_row(grid: ScrollableGrid | null | undefined, row: number): void {
    grid?.scrollTo(0, row, 'vertical', 0, 0, { vAlign: 'start' });
}
```

`ScrollableGrid` is a structural slice of `DataEditorRef.scrollTo` — wide enough
that the real ref satisfies it, narrow enough that the unit test passes a bare
`vi.fn()` spy without importing the Glide runtime. The `grid?.` optional chain
doubles as the not-yet-mounted no-op.

### Wiring: `src/webview/grid-shell.tsx`

The `scrollToRow` message handler calls the helper instead of inlining the bare
`scrollTo`:

```ts
if (msg && msg.type === 'scrollToRow' && typeof msg.row === 'number') {
    scroll_preview_to_row(grid_ref.current, msg.row);
}
```

## Testing

`src/test/preview-scroll.test.ts` (vitest, mirroring
`src/test/preview-scroll-sync.test.ts`):

1. A spy grid asserts `scrollTo(0, 33, 'vertical', 0, 0, { vAlign: 'start' })` —
   the `vAlign: 'start'` is the load-bearing regression detail. This test
   **fails on the pre-#19 code and passes on the fix**.
2. A `null`/`undefined` grid is a no-op (does not throw).

The Glide canvas cannot be driven headlessly, so end-to-end scroll behavior is
confirmed by a manual side-by-side scroll in VS Code; everything testable
without the canvas is unit-covered.

## Out of Scope (verified safe, unchanged)

- **Preview → editor** direction — works; already covered by
  `preview-scroll-sync.test.ts`.
- **The 150 ms bounce-lockout** in `src/csv-preview.ts` — instant `scrollTo`
  lands inside the window.
- **`firstRowIsHeader` offset** — correctly threaded through the line map.
- **No forward padding** on this side. The `PREVIEW_EDITOR_TOP_PADDING_LINES = 5`
  fudge on the preview → editor side exists only to defeat `revealRange`'s
  skip-if-already-visible behavior, a quirk Glide's `scrollTo` does not have.
