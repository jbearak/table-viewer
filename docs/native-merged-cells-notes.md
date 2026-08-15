# Native merged cells — vendored-grid integration notes

Working notes for the merged-cells fork of the vendored glide-data-grid
(src/webview/glide-data-grid/). Stage 2+ hooks in at the points below.
Delete or fold into a real design doc before the PR if stale.

## Rendering pipeline (internal/data-grid/render/)

- `drawGrid` (data-grid-render.ts) orchestrates: damage path (direct cell
  redraw, early return) vs full/blit path. Blit computes `drawRegions` =
  newly exposed strips; `drawCells` then skips every cell whose rect misses
  a draw region (per-cell `intersectRect` check ~line 205).
- `drawCells` (data-grid-render.cells.ts) walks columns then rows.
  Horizontal spans already handled: `cell.span` → `handledSpans` dedup key
  `` `${row},${startCol},${endCol},${c.sticky}` `` → `getSpanBounds` (walk.ts)
  computes full-span rect one row tall; span cells re-clip, push their rect
  into the returned `spans` array (used by drawGridLines to skip borders).
- Merge plan: extend the span concept to 2D. Anchor cell draws at full
  merged bounds (sum of row heights from anchor row); covered cells skip
  content but still draw background. Dedup key must NOT include row for
  multi-row merges (or include anchor row). `getSpanBounds` needs a
  rowSpan-aware variant summing `getRowHeight` over the merged rows.
  Draw-region intersection must test the merged rect, not the single cell,
  so blit-exposed strips repaint the whole merge (this preserves blitting).
- `walkRowsInCol` never visits rows above the viewport start → an anchor
  above the viewport is never walked. Damage/draw for merges whose anchor is
  off-screen must be handled by expanding the effective draw rect when a
  covered cell is walked (or by starting the walk at the anchor row for
  merged columns).
- `drawCell` uses module-level scratch objects (allocatedItem, reusableRect)
  — hot path, avoid allocation.

## Blit & damage

- `computeCanBlit` (blit.ts) — memo-ish equality on DrawGridArg fields;
  mergedRanges must join this list (deep-memo at the prop layer so identity
  is stable when content unchanged).
- `blitLastFrame` returns exposed `drawRegions`. Merge-correctness hook:
  expand each region to include any merged range it intersects (in pixel
  space) OR rely on drawCells intersecting the full merged rect (preferred —
  no region math, cells not in a merge unaffected).
- Damage: `damageInternal` (data-grid.tsx ~line 871) takes a CellSet;
  expansion point: map every damaged cell to its merge anchor + full covered
  set before drawing. CellSet stores packed col/row numbers
  (packColRowToNumber in common/render-state-provider.ts).

## Hit testing / bounds

- `getBoundsForItem` (data-grid.tsx ~422) → `computeBounds`
  (data-grid-lib.ts ~747): single cell only; needs merge-aware variant
  returning the union rect for any cell in a merge (used by overlay editor
  target, fill handle, a11y focus).
- `getMouseArgsForPosition` (~479): col/row from pixel; merge canonicalization
  to anchor happens after (in data-editor or here — decide: here, so all
  consumers see anchor coords + full bounds).

## Selection / navigation (data-editor/)

- `cellIsSelected`, `cellIsInRect`, `cellIsInRange` (data-grid-lib.ts ~71):
  row-equality assumptions; need rowSpan awareness.
- `expandSelection` (data-editor-fns.ts): fixpoint loop growing left/right
  via cell.span; extend to grow up/down via merged ranges. NOTE it reads
  only left+right edge columns when width>2 — a vertical merge in the middle
  is fine (flattened) but edge reading must also fetch top/bottom rows once
  vertical growth exists. App-side selection.ts expand_range_for_merges is
  the oracle.
- `adjustSelection` (data-editor.tsx ~2654): shift+arrow logic;
  `getSpanStops` disallows partial span cuts horizontally; vertical analog
  needed.
- `updateSelectedCell` clamps; navigation lands on covered cells must
  canonicalize to anchor (app-side move_active_cell is the oracle).

## Editing

- Overlay editor target = `bounds` passed to `setOverlaySimple`
  (data-editor.tsx ~1395 reselect path); giving it merge-aware
  getBoundsForItem output makes the editor cover the merged rect for free.

## Clipboard (Stage 4)

- copy-paste.ts `createBufferFromGridCells` has an upstream bug:
  `cells.map((row, index) => columnIndexes[index])` — row index used to
  index columns. Fix when touching this file.
- Span cells emit "" for non-anchor columns (span[0] !== mappedIndex);
  vertical analog: covered rows emit "".

## Accessibility

- data-grid.tsx accessibilityTree (~1633): one td per visible cell, id
  `glide-cell-${col}-${row}`; merged cell → single td with
  rowSpan/colSpan on the anchor, covered cells omitted. Desktop smoke
  depends on `#glide-cell-1-0` and aria-selected. `accessibilityHeight`
  rows rendered from cellYOffset.
- `getCellContent(location, true)` (forceStrict) used by a11y tree.

## Cell content mangling

- `getMangledCellContent` (~1256) shifts span by rowMarkerOffset. The
  mergedRanges prop is in unmangled (outer) coords; resolver must apply
  rowMarkerOffset the same way (col + rowMarkerOffset).

## App-side oracles (Stage 5 cutover)

- src/webview/merge-index.ts (MergeIndex), selection.ts
  (resolve_merge_anchor, move_active_cell, expand_range_for_merges),
  cell-renderer.ts (BLANK for rowSpan>1 — removed at cutover).
- Compatibility contracts: `.gdg-clip-region`, `#portal`,
  `#glide-cell-<col>-<row>`, `[data-testid="data-grid-canvas"]`,
  `.dvn-scroller`, 36px header.

## Stage 2 review decisions (recorded 2026-08-15)

- Selection/hover accents on merges: rendering redirects covered cells to the
  anchor, so clicking/hovering a covered cell doesn't accent the merge until
  Stage 3 canonicalizes mouse args + selection to the anchor. Known, deferred
  by design (Stage 2 is rendering-only; app doesn't pass mergedRanges yet).
- Freeze-trailing rows: merges are not resolved in sticky rows; a merge
  reaching into the freeze band is clipped at the band and the sticky rows
  draw their own cells. Merges wholly inside the band render as plain cells.
  Table-viewer never freezes trailing rows; acceptable fork limitation.
- Column DnD: merge bounds use source order; a merge dragged apart is wrong
  mid-drag. App doesn't use column reordering; not worth the complexity.
- Image loader keys off the anchor row, which can sit outside the visible
  window; Stage 5 handles anchor-row preloading (app side already plans it).
- Resolver stores one Map entry per covered cell (O(area) build/memory) as a
  deliberate trade for allocation-free O(1) hot-loop lookups.
- Kept the merge branch in drawCells separate from the upstream cell.span
  branch: merges resolve before getCellContent (anchor redirect), spans after
  (span comes from the fetched cell); dedup semantics differ (per-merge vs
  per-row). Shared piece extracted: beginMultiCellClip.

## Stage 3 review decisions (recorded 2026-08-15)

- Frozen-area merges now excluded at the source: the resolver drops merges
  reaching into frozen trailing rows (rowCount = rows - freezeTrailingRows)
  or crossing the frozen-column boundary (their halves occupy unrelated
  screen positions, so no single rect can describe hit bounds). This makes
  rendering, hit-testing, bounds, selection, and navigation consistent
  without per-consumer exclusion logic. Merges wholly inside the frozen
  column band still work.
- getBoundsForItem uses combineRects for the merged union (extrema-based, no
  monotonic-position assumption); with boundary-crossing merges dropped, the
  anchor and last cell always share a pane.
- setGridSelection is the invariant chokepoint: it canonicalizes the active
  cell to the merge anchor AND fixpoint-expands the range, so every ingress
  (mouse, keyboard, controlled selection, a11y) holds the invariants.
- updateSelectedCell only steps PAST a merge when the caller passes
  stepPastMerges (keyboard movement, edit-finish movement); absolute jumps
  (search, context menu) just canonicalize to the anchor.
- adjustSelection's horizontal shrink alternates merge-boundary jumps with
  getSpanStops rechecks to a fixpoint (both move toward the active cell, so
  it terminates); vertical edges have no span interaction.
- Copy-pasted edge loops consolidated into resolver adjustRowBoundary /
  adjustColBoundary; mergeCrossing*Line became private.
- Not done (deliberate): per-event resolver double-lookup in hit-test +
  getBoundsForItem (two Map hits per pointer event — measured harmless,
  perf gate green); boundsFor closure churn in getBoundsForItem (mirrors
  upstream style, not a hot loop).

## Stage 4 review decisions (recorded 2026-08-15)

- Fixed: default (onPaste undefined) single-cell paste into a covered cell —
  reachable via column/row selections whose first cell is covered — now
  no-ops rather than editing the covered cell.
- Fixed: a11y stand-in cell used Math.max(merge edge, window start), which
  breaks when visibleCols is non-contiguous (frozen columns). Now the first
  rendered cell of the merge (intersection of visibleCols/visibleRows with
  the merge) represents it.
- Added resolver isCovered(col,row); copy blanking and both paste paths use
  it instead of hand-rolled anchor comparisons.
- Not done (deliberate): folding merge blanking into
  createBufferFromGridCells would push resolver knowledge into
  copy-paste.ts (span blanking is per-cell data, merge blanking needs grid
  coords); copies are user-triggered, so the extra map over the copied
  range is not hot.

## Stage 5 (app cutover) decisions (recorded 2026-08-15)

- MergeOverlay canvas unmounted from GridShell: no overlay ref, no
  scroll-repaint RAF machinery, no highlight_version tick. Merges reach the
  grid as `mergedRanges` (a direct 1:1 map of App's `merges`, which App
  already withholds under any non-identity view — sort/filter/hidden
  rows/columns — so display space == source space whenever ranges are
  supplied; a partial projection would be worse than none).
- cell-renderer lost its merge branches entirely: the vendored draw loop
  redirects covered cells to the anchor before calling getCellContent, so
  every cell just returns its own content.
- Arrow keys defer to Glide (merge-aware stepPastMerges); the shell still
  intercepts Tab (application row-major order needs is_covered) and hjkl
  (view-mode vim nav via merge-aware move_active_cell).
- Selection normalization split: grid-originated selections are already
  canonicalized by the vendored setGridSelection chokepoint, so
  onGridSelectionChange writes through directly; shell-originated writes
  (select_active_display_cell, context menu) bypass that chokepoint and
  grid_selection_ref is read synchronously, so they still run
  expand_glide_selection themselves.
- Off-screen merge anchors: onVisibleRegionChanged preloads anchor rows of
  merges straddling the viewport top via ensure_rows_loaded (viewport
  untouched); both source-key repaint effects (tints and highlights) append
  offscreen_anchor_merge_damage, which damages one covered cell per merge
  whose *anchor key* changed — the grid's expandDamage repaints the whole
  block from any member cell.
- Not done (deliberate): RowLoader-level anchor residency/pinning (the
  ensure_rows_loaded request dedupe already avoids network churn; an anchor
  evicted after its waiter resolves self-heals on the next scroll tick);
  sharing one merge resolver between the app's MergeIndex and the vendored
  resolver (MergeIndex is still needed for guarded copy and Tab; overlap
  shrinks in Stage 6 when the overlay modules are deleted).

## Stage 5 /code-review decisions (recorded 2026-08-15)

- Fixed: native Delete/Cut (deleteRange in the vendored data-editor) iterated
  every coordinate of the selection and would have recorded empty edits for
  covered members of a merge; it now skips isCovered cells so a merged block
  deletes as one cell (anchor only). Covered by a new vendor test.
- Fixed: editor commit navigation (Enter/Tab out of the custom CSV editor)
  called move_sequential_cell without the covered predicate, so leaving a
  vertical/2D merge could target a covered cell that selection
  canonicalization snapped straight back to the anchor. It now passes
  merge_index.is_covered (via a ref), and move_sequential_cell's 'below' arm
  skips covered rows too.
- Fixed: hit-test canonicalization (anchor location + full block bounds)
  starved consumers that need per-cell geometry. The vendored cell event args
  now also carry physicalLocation/physicalBounds (the un-snapped cell);
  row-resize boundary detection, header drag-sweep, and row-marker drag-sweep
  read those, so a merge's interior/bottom boundaries resize the right row and
  drags sweep past merges instead of yanking to the anchor.
- Fixed: multiline auto-grow measured only the anchor row; a vertical merge
  paints across the whole block, so it now compares the needed height against
  the block's total and grows the anchor by the deficit only.
- Fixed: offscreen_anchor_merge_damage handled only anchors above the
  viewport; it now also repairs blocks whose anchor is left of the viewport
  (horizontal and 2D merges). Both repaint effects share the pipeline via
  source_key_damage, and the anchor key is built with cell_highlight_key
  rather than a second hand-rolled `${row}:${col}`.
- Fixed: restored the shared immutable BLANK fast path in build_grid_cell for
  the no-content/no-overlay case (getCellContent is per-visible-cell,
  per-draw; the rewrite had made every unloaded blank allocate).
- Fixed: the per-scroll anchor preload scan now walks a memoized
  vertical-merges-only list instead of filtering the full (10k-capped) list on
  every visible-region callback.
- Not done (deliberate): select_row/select_column writing rectangles that cut
  a merge (a one-row selection across a vertical merge). This matches
  spreadsheet convention — selecting row 3 in Excel does not balloon to every
  merge the row crosses — and matches main's behavior; guarded copy of such a
  row correctly emits a blank for the covered member.
- Not done (deliberate): indexing offscreen_anchor_merge_damage by anchor key.
  The linear scan runs only on tint/highlight *transitions* (user edits,
  saves, discards), not per frame; 10k cheap comparisons per commit is noise.
