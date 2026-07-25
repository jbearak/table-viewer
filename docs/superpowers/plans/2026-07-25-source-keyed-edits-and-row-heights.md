# Source-keyed edits (and row heights): letting Edit mode coexist with sorts, filters, and hidden rows

Reviewed by codex (gpt-5.6-sol, xhigh) — see
`docs/superpowers/reviews/2026-07-25-codex-plan-review.md`. That review found
five P0s in the first draft, one of which invalidated a whole feature. This
revision is the result.

## Problem

Toggling Edit mode re-renders the grid and forces the user to clear sorting,
filters, and hidden rows first. The stated reason ("avoid refiltering on each
edit") is not the real one.

The real reason is a row-space aliasing invariant:

- The dirty map is keyed `` `${row}:${source_column}` `` where `row` is the
  **Glide display row** (`use-editing.ts:109`; `grid-shell.tsx:1368` passes
  Glide's row index straight into `commit_edit`).
- The save path treats that same key's row component as an **absolute source
  row**: `serialize_csv` walks the untransformed source and looks up
  `edits[`${r}:${c}`]` by its own counter (`serialize-csv.ts:49`), reading via
  `src.read_rows(...)` rather than through `transform_indices`
  (`viewer-controller.ts:2498`).

Those two row spaces coincide only when no transform is installed. Enforcing
that coincidence is what `transform_blocks_editing()` does
(`viewer-controller.ts:545`). Without it, editing display row 5 under a sort
writes source row 5 — silent corruption of the wrong row.

Hidden rows are not the lenient case they appear to be: all three transforms
funnel into one permutation, and `compute_transform` builds its survivor mask
from `hiddenRows` exactly as for filters (`table-transform.ts:124`).

## What the review changed

Four things I had wrong or missing, in descending order of consequence.

### 1. "Resort/Refilter" cannot work on unsaved edits at all

`compute_transform` reads columns straight from the `DataSource`
(`table-transform.ts:166`, `acquire_transform_column(source, …)`). Dirty values
are overlaid **only** during CSV serialization (`viewer-controller.ts:2503`),
and `setTransform` carries no edits (`types.ts:323`). So a "Resort" button would
recompute from unedited data and reproduce the identical ordering — a control
that appears to work and does nothing.

This kills the banner as originally conceived. Options were: plumb an
edit-snapshot revision through transform requests and overlay it in the host's
column reads (a large change to the transform engine's data path), or don't
offer recomputation on unsaved edits.

**Decision: don't offer it.** The banner becomes purely informational — "Edits
since this view was sorted/filtered aren't reflected in the current order. Save
to recompute." No misleading button. Recomputation after save happens naturally
via source reload. Overlaying edits into transform column reads is a separate
feature with its own perf question (it would defeat the column cache), not a
rider on a correctness fix.

### 2. Edits do not survive a transform remount

`initial_edits` is consumed only by `use_editing`'s one-time `useState`
initializer (`use-editing.ts:81`), and `use_editing` lives inside GridShell
(`grid-shell.tsx:553`), which is keyed on `generation` (`app.tsx:2252`) — bumped
by every `transformApplied` (`app.tsx:1109`). So once sorting during edit mode is
legal, **every sort unmounts the component owning the dirty map**, and App holds
current edits only in a ref (`app.tsx:1845`) that it never feeds back into the
prop.

Removing the grant remount (`app.tsx:1787`) has the same defect from the other
direction: restored edits would never install.

This is now the load-bearing work of PR 1, ahead of the rekey itself. The dirty
map must be owned above the grid generation.

### 3. Non-resident cells are editable by design

`grid-shell.tsx:1318` — "Empty/unloaded cells stay editable so blanks can be
typed", and `cell-renderer.ts:147` synthesizes an editable blank for a missing
row. My proposed "bail if `get_source_row` is undefined" would have silently
discarded text the user typed before the page arrived. Needs a real answer, not
a bail.

### 4. `transform_blocks_editing` is a file-level concurrency barrier

`begin_transform_admission` requires the edit phase to be exactly `free`
(`viewer-controller.ts:599`), serializing transforms against claiming, owned,
releasing, cleanup and uncertain phases across *sibling panels* on the same
file. Save's reservation is installed only after serialization
(`viewer-controller.ts:2521`). Deleting the guard wholesale would permit a
transform mid-save. It needs replacing with an explicit admission matrix, not
removing.

Also corrected: my claim that display indices are "converted immediately at the
Glide boundary" is false as a general statement. Display intervals deliberately
cross the protocol for highlights and row-hiding (`types.ts:324, 326`), which is
safe because the host validates generation and maps them through the core
(`viewer-controller.ts:3274, 3480`). The source-key contract applies to
**durable edit identity**, not to every row index on the wire.

And: there is no find/search state to migrate — GridShell never passes Glide's
`searchResults` (`grid-shell.tsx:2476`); only the theme color is set.

---

## Revised sequencing: three PRs

The review's conclusion — "PR 1 needs an edit-session-owned state model,
host-side base validation, and a replacement admission protocol" — is three
separable pieces of work. Bundling them is what made the original PR 1 unsafe.

### PR 1 — Lift edit state above the grid generation

No behavior change; pure refactor, independently verifiable.

- Move the dirty map out of GridShell into a session-owned store in App (or a
  small `use_edit_session` hook there) whose lifetime is the **edit session**,
  not the grid generation. GridShell becomes a view over it.
- `use_editing`'s state becomes derived/controlled rather than
  initializer-seeded, so a changed edit map installs without a remount.
- Fold the open Glide editor into the store before any generation change.
- Keep every existing transform/edit block in place.
- Tests: edits survive a synthetic generation bump; grant-restored edits install
  without a remount; live editor content folds in rather than being lost.

This alone fixes a latent bug: a generation bump from an external refresh
currently relies on the rehydration path to not lose edits.

### PR 2 — Source-key edit identity

- **`row-loader.ts`**: add a `source_row → page location` map (per the review's
  #9, expose `get_row_for_source` / `get_cell_raw_for_source` rather than
  another display index). Maintain on ingest, replacement, eviction, `clear`,
  sheet change and generation change. Document that its size tracks resident
  pages **including bulk-copy waiters**, which are exempt from `max_pages`
  (`row-loader.ts:137, 274`) and can reach 100k rows via "Copy sheet"
  (`grid-shell.tsx:1855`) — my 5,000-entry bound was wrong.
- **Non-resident commits**: resolve the source row at *overlay open* time, not
  at commit. If identity is unavailable, request the page and keep the cell
  non-editable until it resolves, so no typed text is ever accepted and dropped.
  Blank-but-resident cells stay editable exactly as today.
- **Rekey** `use-editing.ts` and the Glide-boundary conversions:
  `on_cell_edited` (`:1368`), `get_cell_content` (`:1306`), `get_cell_raw` /
  `saved_edits_ref` (`:531`), `read_live_edit` (`:879`),
  `displayed_cell_text` (`:1071`), copy overlay (`:1760`), `discard_edit`
  (`:1898`), tint repaint (`:2309`), context menu (`:2414`).
  For repaints prefer the existing visible-row scan
  (`grid-repaint-model.ts:46`) over a reverse lookup.
- **Host-side base validation before save** (review #3): a filtered or hidden
  dirty row can be permanently absent from the transformed loader, so
  resident-only conflict detection (`use-editing.ts:52`, "unknown, not a
  conflict") stops being sufficient. Validate every source-keyed `base` against
  the current source at save time, independent of residency, distinguishing:
  absent from the filtered view (valid); removed by an actual file shrink
  (`serialize-csv.ts:68` currently appends these — needs an explicit policy);
  base mismatch (reject with exact conflict keys).
- Migration: existing `pendingEdits` are reinterpreted as source-keyed.
  Sound because CSV has `rowCount === sourceRowCount`
  (`data-source/csv-source.ts:139`) and the current barriers prevented any edit
  from being created under a transform. `resolve_csv_save_hydration`
  (`csv-save-lifecycle.ts:96`) passes keys through verbatim, so no code change.
- Still blocked: transforms during edit mode. This PR makes them *safe to
  allow*; PR 3 allows them.

### PR 3 — Admission matrix, then unblock

- Define explicitly which phases admit a transform, replacing the
  `phase.type !== 'free'` refusal (`viewer-controller.ts:599`). Transforms stay
  blocked during save, releasing, cleanup and uncertain; decide and document
  whether `owned` admits them from the owning panel only or from siblings too.
  Preserve operation tokens and claim serialization. Enforce host-side, and
  disable the UI on `editing_status.save_in_flight`.
- Audit every gate individually, classifying each as UI affordance, same-panel
  authority, or file-level concurrency — do **not** mechanically delete
  `edit_mode` checks. Known sites: `viewer-controller.ts:545, 597, 700, 731,
  2846, 3361, 3402, 3414`; `app.tsx:1438, 1490, 1533, 1618, 2388`;
  `grid-shell.tsx:2417, 2560`. `edit_session_pending` and save/cleanup guards
  keep valid ordering roles.
- Stop suppressing transforms in edit mode: `visible_transform`
  (`app.tsx:2197`), `transform_sections`, `transform_disabled`. **`preview_mode`
  keeps its suppression** — `viewer-controller.ts:2682-2687` documents that
  synchronized CSV preview needs display rows in natural source order so
  `visibleRowChanged` can index the source-line map, and treats it as a trust
  boundary.
- Drop the now-unnecessary remounts (`app.tsx:1787`; `edit_mode` from the
  restore effect deps at `:1269`), which PR 1 made safe.
- Add the informational stale-view banner (per the decision above): mark stale
  by comparing the **current dirty map** against the installed sort keys and
  enabled filter columns (`needed_columns`, `table-transform.ts:922`), so
  reverting or discarding the last relevant edit clears it. Clear on save +
  reload, on discard, and only on an acknowledgement that is not older than the
  edits it claims to cover.
- Guard the multiline auto-grow height write (`grid-shell.tsx:1385`) — it is
  ungated on `transformed`, unlike hover-arming (`:1521`) and the resize overlay
  (`:2516`), so this is the one place a display-keyed height could be written
  once transforms and edit mode coexist. Removed in PR 4.

### PR 4 — Source-key row heights

Heights are currently **suppressed, not misapplied**: `app.tsx:2262` replaces
the map with `{}` under any active transform, the resize overlay is unmounted
(`grid-shell.tsx:2516`), hover-arming bails (`:1521`), and Excel header changes
drop heights outright (`excel-header-plan.ts:118`). So the user-visible bug is
that custom heights vanish on sort and return on clear.

Correcting it needs a different mechanism from edits, which is why it is last:
Glide sums `rowHeight(r)` over **every** row for total scroll height
(`scrolling-data-grid.js:18-20`), so a resident-only reverse lookup would report
default heights for non-resident overridden rows and total height would drift as
pages load — scrollbar jitter.

- Persist source-keyed; render from a host-computed sparse display-keyed
  projection built via `ViewerPanelCore.display_row_for_source`
  (`panel-core.ts:264`), the existing full inverse. Cost is O(overrides).
- Deliver it generation-bound. `transformApplied` carries no layout projection
  today (`types.ts:302`) and user transforms do not necessarily produce a new
  workbook snapshot, so snapshot delivery alone is insufficient — add a field
  to `transformApplied` (or a separate projection message) *and* include it in
  snapshots. Recompute on transform installation, source adoption, row-height
  changes, and state-store updates from sibling panels.
- On resize, map display → source via the resident row, update the projection
  optimistically, post source-keyed heights.
- Then remove the suppression, re-enable resize under transforms, and remove
  PR 3's auto-grow guard.
- Migration: drop pre-migration heights once. Not for the reason I originally
  gave (they are not already-corrupted — no transformed-display write is
  currently reachable), but because old keys are projected-row keys and
  reinterpreting them as canonical physical rows would silently move heights.

## Out of scope

- Overlaying unsaved edits into transform column reads, i.e. genuinely
  re-sorting dirty data. This is the honest version of "Resort" and is a real
  feature; it needs a design for the column cache
  (`acquire_transform_column`) and its own perf budget.
- `PerFileState.scrollPosition` is row-addressed with the same latent question.
- Enabling Glide search later: its result `Item`s are display coordinates and
  would need generation-scoping.
