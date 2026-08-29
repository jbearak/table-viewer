# Rightmost column resize UX

## Question

How should Table Viewer make it easier to widen the rightmost column, especially when its right border sits against the edge of the webview?

## Implementation status

The follow-up implementation uses a 32 px trailing runway and starts edge scrolling in its final 24 px. Scroll distance contributes to column width, the scroll-range lock retains the largest width reached during the drag, and mouse-up, Escape, pointer cancellation, window blur, or unmount stop the animation loop. Pointer capture and the secondary menu and keyboard routes described below remain possible follow-ups.

## What other tools do

Excel and Google Sheets rarely expose a data column as the physical end of the grid. Excel worksheets contain 16,384 columns, so blank columns usually remain to the right of the user's data. Google Sheets likewise lets users insert columns to the right. This gives an ordinary data column a large horizontal runway even when it is the last populated column. Both products let users drag the right boundary of a column header. Both also support double-clicking that boundary to fit the column to its contents. Excel additionally exposes AutoFit and an exact Column Width command. Google Sheets exposes Fit to data and a custom width through the column context menu.

Sources: [Microsoft Excel specifications and limits](https://support.microsoft.com/en-US/Excel/excel-specifications-and-limits), [Microsoft column width help](https://support.microsoft.com/en-us/excel/change-the-column-width-and-row-height), [Google Sheets column help](https://support.google.com/docs/answer/54813?hl=en-GB).

Apple Numbers uses finite table objects on a larger canvas. The table's right edge therefore usually has canvas space after it. Numbers lets users drag the boundary to the right of a column letter. It also provides a precise width control in the Format sidebar and a Fit Width to Content command in the column menu. A double-click on the boundary fits the content.

Source: [Apple Numbers row and column resizing](https://support.apple.com/fr-fr/guide/numbers/tan3e89d0c0f/mac).

Airtable tells users to drag a field's header edge. Its grid is closer to Table Viewer than an open-ended spreadsheet because its columns correspond to defined fields rather than the full worksheet. Its official help does not document edge-scrolling or a special last-field resize behavior.

Source: [Airtable grid view](https://support.airtable.com/articles/7905594155-airtable-grid-view).

Data-grid libraries repeat the same boundary-drag and double-click pattern. AG Grid also supports keyboard resizing with Alt or Option plus Left or Right Arrow. It supports two distinct auto-size modes: fit the grid and fit cell content. Handsontable supports dragging a header separator, double-clicking it to fit the longest value, and resizing multiple selected columns together.

Sources: [AG Grid column sizing](https://www.ag-grid.com/javascript-data-grid/column-sizing/), [Handsontable column widths](https://handsontable.com/docs/javascript-data-grid/column-width/), [MUI Data Grid column dimensions](https://mui.com/x/react-data-grid/column-dimensions/).

The accessibility case for a non-drag route is strong. WCAG 2.2 requires functionality that uses dragging to have a single-pointer alternative unless dragging is essential. Its minimum target-size criterion is 24 by 24 CSS pixels, subject to spacing and equivalent-control exceptions.

Source: [WCAG 2.2](https://www.w3.org/TR/WCAG22/), [W3C target-size explanation](https://www.w3.org/WAI/WCAG22/Understanding/target-size-minimum).

## What Table Viewer did before this implementation

Table Viewer already had several fixes aimed at the final divider:

- `LAST_COLUMN_RESIZE_GUTTER_PX` adds 8 px of horizontal overscroll.
- Glide's hit test accepts the last divider from the out-of-bounds header region.
- The scrolling grid holds the starting scroll width while the last column shrinks, which prevents the browser from clamping `scrollLeft` and making the divider slide away from the pointer.
- Mouse movement is observed on `window`, so a resize continues after the pointer leaves the canvas but remains inside the webview window.

These changes mainly help users acquire the divider and drag it left. They do little for outward growth. The last boundary starts only 8 px inside the viewport, so an outward drag runs into the webview edge almost immediately. The resize width is currently derived from pointer position alone, so there is no way to keep widening once the pointer stops at that edge.

Relevant code: `src/webview/grid-model.ts`, `src/webview/glide-data-grid/internal/data-grid/data-grid.tsx`, `src/webview/glide-data-grid/internal/data-grid-dnd/data-grid-dnd.tsx`, and `src/webview/glide-data-grid/internal/scrolling-data-grid/scrolling-data-grid.tsx`.

## Recommended direct-manipulation model

### 1. Add real trailing runway

Raise the last-column gutter from 8 px to 32 px. Keep it as blank scroll padding, not a fake data column. That is enough room to acquire the divider and make modest adjustments. A 64 px gutter takes more space than it earns once edge scrolling handles longer drags.

The gutter should be visually quiet. When the pointer approaches the final divider, a subtle grip or highlighted rule can make the resize affordance clear. The interactive hit region can be wider than the painted line.

This is an immediate improvement, not a complete solution. A fixed gutter still limits how far the user can grow the column in one drag.

### 2. Add edge autoscroll during resize

When a resize drag enters a 24 to 32 px zone at the right edge, advance horizontal scroll while the pointer remains held. Continue the resize on animation frames even if the pointer itself is stationary.

The width calculation needs to include scroll movement:

```text
new width = start width
          + pointer x delta
          + horizontal scroll delta
```

Without the scroll delta, autoscrolling merely moves the grid. With it, every pixel scrolled right becomes another pixel of column width and the divider can remain visually attached to the pointer.

Use a speed curve based on proximity to the edge. A slow rate near the start of the zone gives control; a faster rate at the window edge handles large increases. Stop immediately on pointer-up, pointer-cancel, lost capture, Escape, or loss of window focus.

### 3. Preserve a safe divider position

Once the pointer reaches the edge zone, keep the divider 16 to 24 px inside the viewport. Grow the scrollable width as needed and adjust `scrollLeft` in lockstep. This prevents the divider from disappearing under the window chrome and makes the drag feel continuous.

The existing scroll-width floor solves the inverse case for shrinking. The growth path needs a dynamic floor or extra temporary trailing space so edge autoscroll always has somewhere to go. Collapse that temporary space after the drag ends, then clamp scroll position while keeping the resized divider visible.

### 4. Use pointer capture

Move the resize interaction to Pointer Events and call `setPointerCapture` on pointer-down. Window-level mouse listeners work inside the webview, but pointer capture makes ownership explicit and handles pen and touch consistently. Edge autoscroll is still necessary because no browser can guarantee useful movement events after the pointer leaves the application window.

## Secondary routes

Keep double-click auto-fit. Add Auto-fit column and Set column width commands to the column menu, and consider AG Grid's Alt or Option plus Arrow keyboard convention. These do not fix the outward drag, but they keep dragging from becoming the only way to reach a large width and satisfy the spirit of WCAG's dragging alternative.

## Suggested order

1. Increase the trailing runway to 32 px and widen the invisible final-edge hit zone.
2. Implement edge autoscroll using pointer delta plus scroll delta.
3. Add pointer capture and cancellation handling.
4. Add a small width readout during drag, then add menu and keyboard alternatives.

The first step is cheap and should make the current interaction noticeably less cramped. The second is the real fix. It gives the rightmost divider effectively unlimited outward travel while keeping direct manipulation intact.
