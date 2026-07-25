# Codex plan review — 2026-07-25

gpt-5.6-sol, xhigh reasoning, reviewing docs/superpowers/plans/2026-07-25-source-keyed-edits-and-row-heights.md.
Full transcript (file reads) discarded; findings verbatim below.

## Prioritized findings

1. **P0 — PR 1 loses pending and live edits on remounts.**

   `initial_edits` is consumed only by the one-time `useState` initializer in [use-editing.ts:81](/Users/jmb/repos/Extensions/table-viewer.worktrees/release-binaries/src/webview/use-editing.ts:81). The current edit grant updates `initial_edits` and deliberately forces a remount at [app.tsx:1785](/Users/jmb/repos/Extensions/table-viewer.worktrees/release-binaries/src/webview/app.tsx:1785) and [app.tsx:1787](/Users/jmb/repos/Extensions/table-viewer.worktrees/release-binaries/src/webview/app.tsx:1787). Removing that remount, as proposed, means restored edits from the grant are never installed into the existing hook.

   Every successful transform also changes `generation` at [app.tsx:1109](/Users/jmb/repos/Extensions/table-viewer.worktrees/release-binaries/src/webview/app.tsx:1109), and `generation` is part of the grid key at [app.tsx:2252](/Users/jmb/repos/Extensions/table-viewer.worktrees/release-binaries/src/webview/app.tsx:2252). Thus transform application unmounts the dirty map. App records current edits only in a ref at [app.tsx:1845](/Users/jmb/repos/Extensions/table-viewer.worktrees/release-binaries/src/webview/app.tsx:1845); it does not update the `initial_edits` prop before a transform remount.

   **Recommendation:** Hoist the authoritative source-keyed edit map to App or another session-owned store that survives grid generations. Treat GridShell as a view over that state. Until that exists, retain the edit-grant remount. Before dispatching any transform, synchronously fold the open editor into the session-owned map.

2. **P0 — The proposed “Resort/Refilter” action cannot work on unsaved edits.**

   A `setTransform` message contains only transform state and generation fields, not edits, at [types.ts:323](/Users/jmb/repos/Extensions/table-viewer.worktrees/release-binaries/src/types.ts:323). Transform computation reads columns directly from the underlying `DataSource` at [table-transform.ts:166](/Users/jmb/repos/Extensions/table-viewer.worktrees/release-binaries/src/table-transform.ts:166). Dirty values are overlaid only during CSV serialization at [viewer-controller.ts:2503](/Users/jmb/repos/Extensions/table-viewer.worktrees/release-binaries/src/viewer-controller.ts:2503).

   Therefore, reissuing the transform before save recomputes exactly the old ordering/filter membership. Worse, a commit made while a transform is already computing can mark the view stale, then the old transform acknowledgement would clear the flag under the plan.

   **Recommendation:** Either:

   - disable recomputation until edits are saved and the source reloads; or
   - include an immutable edit-map revision in transform requests and have host transform reads overlay that exact edit snapshot.

   Only clear stale state when the acknowledgement proves it incorporated the same or newer edit revision. Derive staleness from the current dirty map so reverting or discarding the last relevant edit clears it correctly.

3. **P0 — Resident-only conflict detection becomes unsafe once filters and hidden rows can remove dirty rows.**

   `use_editing` deliberately treats a non-resident source cell as “not conflicted” at [use-editing.ts:52](/Users/jmb/repos/Extensions/table-viewer.worktrees/release-binaries/src/webview/use-editing.ts:52). A filtered or hidden dirty source row may be permanently absent from the transformed row-loader, not merely evicted temporarily.

   The host carries `dirtyEdits.base`, but save never compares those bases with current source cells. It serializes `identity.edits` directly at [viewer-controller.ts:2496](/Users/jmb/repos/Extensions/table-viewer.worktrees/release-binaries/src/viewer-controller.ts:2496). After an external refresh, a hidden dirty row can therefore overwrite a changed source value without ever becoming visibly conflicted.

   Page eviction has the same pre-existing weakness. Source shrink adds another issue: `serialize_csv` intentionally appends edits beyond the new last source row at [serialize-csv.ts:68](/Users/jmb/repos/Extensions/table-viewer.worktrees/release-binaries/src/serialize-csv.ts:68).

   **Recommendation:** Before accepting a save, validate every source-keyed dirty base directly against the current source, independently of row-loader residency. Distinguish:

   - rows absent only from the effective filtered view — still valid;
   - source rows removed by an actual file shrink — conflict or explicit append policy;
   - base mismatches — return exact conflict keys and reject the save.

4. **P0 — The plan removes a file-level concurrency barrier without defining its replacement.**

   `transform_blocks_editing` is not merely a UI check. It tracks in-flight transform work, active transformed panels, and durable transform state at [viewer-controller.ts:545](/Users/jmb/repos/Extensions/table-viewer.worktrees/release-binaries/src/viewer-controller.ts:545). `begin_transform_admission` currently requires the edit phase to be exactly `free` at [viewer-controller.ts:597](/Users/jmb/repos/Extensions/table-viewer.worktrees/release-binaries/src/viewer-controller.ts:597), serializing transforms against claiming, owned, releasing, cleanup, and uncertain phases.

   Blindly permitting transforms during every non-free phase would allow:

   - a transform while save is preparing/writing;
   - a sibling-panel transform while another panel owns edits;
   - transform installation during release or failed-save cleanup;
   - an edit claim and transform overtaking each other around asynchronous state I/O.

   Save reservation is also installed only after serialization at [viewer-controller.ts:2521](/Users/jmb/repos/Extensions/table-viewer.worktrees/release-binaries/src/viewer-controller.ts:2521).

   **Recommendation:** Define an explicit admission matrix. At minimum, transformations should remain blocked during save, releasing, cleanup, and uncertain phases. If transforms are allowed during `owned`, identify whether only the owning panel or sibling panels may initiate them. Preserve operation tokens and claim serialization. Disable transform controls on `editing_status.save_in_flight`, and enforce the same rule host-side.

5. **P0 — “Interacted rows are resident by definition” is simply wrong.**

   GridShell deliberately makes unloaded blank cells editable at [grid-shell.tsx:1317](/Users/jmb/repos/Extensions/table-viewer.worktrees/release-binaries/src/webview/grid-shell.tsx:1317), and `build_grid_cell` synthesizes an editable blank for a missing row/cell at [cell-renderer.ts:147](/Users/jmb/repos/Extensions/table-viewer.worktrees/release-binaries/src/webview/cell-renderer.ts:147). But `get_source_row` returns an identity only for a resident page at [row-loader.ts:238](/Users/jmb/repos/Extensions/table-viewer.worktrees/release-binaries/src/webview/row-loader.ts:238).

   The proposed “bail if non-resident” commit would silently discard text entered before the page arrives.

   **Recommendation:** Either make cells editable only after their source identity is resident, or resolve/validate the display row through a generation-bound host request. Never accept an edit overlay and then silently drop its commit.

6. **P1 — The plan misses several edit-mode transform guards, so following it literally would not achieve its goal.**

   Additional blockers not enumerated in the plan include:

   - transform dispatch refusal at [app.tsx:1490](/Users/jmb/repos/Extensions/table-viewer.worktrees/release-binaries/src/webview/app.tsx:1490);
   - row-hiding refusal at [app.tsx:1533](/Users/jmb/repos/Extensions/table-viewer.worktrees/release-binaries/src/webview/app.tsx:1533);
   - filter-editor refusal at [app.tsx:1618](/Users/jmb/repos/Extensions/table-viewer.worktrees/release-binaries/src/webview/app.tsx:1618);
   - cell and row context-menu guards at [grid-shell.tsx:2417](/Users/jmb/repos/Extensions/table-viewer.worktrees/release-binaries/src/webview/grid-shell.tsx:2417) and [grid-shell.tsx:2560](/Users/jmb/repos/Extensions/table-viewer.worktrees/release-binaries/src/webview/grid-shell.tsx:2560);
   - ready-time durable-transform reconciliation admission at [viewer-controller.ts:2846](/Users/jmb/repos/Extensions/table-viewer.worktrees/release-binaries/src/viewer-controller.ts:2846).

   **Recommendation:** Audit every edit/transform gate, classify it as UI, same-panel authority, or file-level concurrency protection, and change tests accordingly. Do not mechanically delete every `edit_mode` check; `edit_session_pending` and save/cleanup guards still have valid ordering roles.

7. **P1 — The row-height analysis is partly right, but its migration claim is wrong.**

   Confirmed:

   - App suppresses heights under transforms at [app.tsx:2262](/Users/jmb/repos/Extensions/table-viewer.worktrees/release-binaries/src/webview/app.tsx:2262).
   - Manual resize is unmounted at [grid-shell.tsx:2516](/Users/jmb/repos/Extensions/table-viewer.worktrees/release-binaries/src/webview/grid-shell.tsx:2516).
   - Hover arming stops at [grid-shell.tsx:1521](/Users/jmb/repos/Extensions/table-viewer.worktrees/release-binaries/src/webview/grid-shell.tsx:1521).
   - Multiline auto-grow is indeed ungated at [grid-shell.tsx:1384](/Users/jmb/repos/Extensions/table-viewer.worktrees/release-binaries/src/webview/grid-shell.tsx:1384).

   So suppression masks a latent inability to project natural/display-keyed heights into a transformed view. It is not masking already-corrupted persisted heights.

   The PR 2 claim that old heights “were reachable under a transform via the pre-existing suppression path” is false. The only writes are auto-grow at [grid-shell.tsx:1385](/Users/jmb/repos/Extensions/table-viewer.worktrees/release-binaries/src/webview/grid-shell.tsx:1385) and manual resize at [grid-shell.tsx:1620](/Users/jmb/repos/Extensions/table-viewer.worktrees/release-binaries/src/webview/grid-shell.tsx:1620); current edit/transform exclusion makes neither a transformed-display write. Excel header changes additionally drop heights at [excel-header-plan.ts:118](/Users/jmb/repos/Extensions/table-viewer.worktrees/release-binaries/src/excel-header-plan.ts:118).

   **Recommendation:** The single auto-grow guard is sufficient for the currently reachable active-transform height writers in PR 1. Add a defensive guard or source/generation-bearing resize contract at App anyway. A PR 2 migration may still defensibly drop old heights because old keys are projected-row rather than canonical physical-row keys, but not for the reason stated in the plan.

8. **P1 — Selection, cursor, live editor, and host-bound display identities need an explicit transform policy.**

   Grid selection is display-keyed component state at [grid-shell.tsx:414](/Users/jmb/repos/Extensions/table-viewer.worktrees/release-binaries/src/webview/grid-shell.tsx:414). The open editor’s location is inferred from that selection at [grid-shell.tsx:873](/Users/jmb/repos/Extensions/table-viewer.worktrees/release-binaries/src/webview/grid-shell.tsx:873). Transform generation remounts currently clear both. That avoids misapplication but can lose an uncommitted live edit unless it is folded first.

   The plan’s broad statement that display indices are converted “immediately” at the Glide boundary is also false. Display intervals intentionally cross the protocol for highlights and hiding at [types.ts:324](/Users/jmb/repos/Extensions/table-viewer.worktrees/release-binaries/src/types.ts:324) and [types.ts:326](/Users/jmb/repos/Extensions/table-viewer.worktrees/release-binaries/src/types.ts:326). These paths are safe because the host validates generation and maps them through the core at [viewer-controller.ts:3274](/Users/jmb/repos/Extensions/table-viewer.worktrees/release-binaries/src/viewer-controller.ts:3274) and [viewer-controller.ts:3480](/Users/jmb/repos/Extensions/table-viewer.worktrees/release-binaries/src/viewer-controller.ts:3480). Excel header promotion follows the same pattern at [viewer-controller.ts:3116](/Users/jmb/repos/Extensions/table-viewer.worktrees/release-binaries/src/viewer-controller.ts:3116).

   **Recommendation:** Scope the source-key contract specifically to durable edit identity. Before transform dispatch, commit the live editor. Then either restore the active cell/selection by source identity after acknowledgement or explicitly clear it and test that behavior. Preserve the generation-validated host mapping used by highlights and row hiding.

   The copy path remains display-oriented by design. Its dirty overlay must translate each display row through `get_source_row`; the plan does mention that conversion. Bulk copy already aborts when a generation change clears the loader at [row-loader.ts:244](/Users/jmb/repos/Extensions/table-viewer.worktrees/release-binaries/src/webview/row-loader.ts:244).

9. **P1 — The proposed reverse index is reasonable locally, but its claimed bound is wrong and the API is too row-space-leaky.**

   The plan claims a hard 5,000-entry bound. RowLoader explicitly allows bulk-copy waiters to retain more than `max_pages` at [row-loader.ts:137](/Users/jmb/repos/Extensions/table-viewer.worktrees/release-binaries/src/webview/row-loader.ts:137), and eviction protects all waiter pages at [row-loader.ts:274](/Users/jmb/repos/Extensions/table-viewer.worktrees/release-binaries/src/webview/row-loader.ts:274). Production “Copy sheet” can load up to 100,000 rows at [grid-shell.tsx:1855](/Users/jmb/repos/Extensions/table-viewer.worktrees/release-binaries/src/webview/grid-shell.tsx:1855).

   There is already a full source-to-display inverse in the host at [panel-core.ts:264](/Users/jmb/repos/Extensions/table-viewer.worktrees/release-binaries/src/panel-core.ts:264), invalidated whenever a transform changes. That is the correct mechanism for row-height projection and host commands.

   **Recommendation:** For the webview, expose `get_row_for_source` or `get_cell_raw_for_source` backed by a source-to-page-location map, rather than broadly exposing another display index. Remove entries on page replacement, eviction, clear, sheet change, and generation change. Document that its size follows resident pages, including temporary bulk loads. For repaints, reuse the existing visible-row scan pattern in [grid-repaint-model.ts:46](/Users/jmb/repos/Extensions/table-viewer.worktrees/release-binaries/src/webview/grid-repaint-model.ts:46), avoiding a reverse lookup altogether.

10. **P1 — PR 2 does not fully specify how projected heights reach the webview.**

    `transformApplied` currently carries no layout projection at [types.ts:302](/Users/jmb/repos/Extensions/table-viewer.worktrees/release-binaries/src/types.ts:302), and its handler updates generation, row count, and transforms only at [app.tsx:1109](/Users/jmb/repos/Extensions/table-viewer.worktrees/release-binaries/src/webview/app.tsx:1109). Snapshot delivery alone is insufficient: user transforms do not necessarily cause a new workbook snapshot.

    Projection also must be recomputed when source-keyed height overrides change, not only when the transform or source changes.

    **Recommendation:** Add a generation-bound projected-height field to `transformApplied` or a separate projection message, and include it in workbook snapshots. Recompute on transform installation, source adoption, row-height state changes, and relevant state-store updates from other panels.

11. **P2 — There is no current find/search result state to migrate.**

    GridShell does not pass Glide’s `showSearch`, `searchResults`, or search callbacks in its `DataEditor` props at [grid-shell.tsx:2476](/Users/jmb/repos/Extensions/table-viewer.worktrees/release-binaries/src/webview/grid-shell.tsx:2476). Only the theme’s search-result color is configured at [vscode-theme.ts:203](/Users/jmb/repos/Extensions/table-viewer.worktrees/release-binaries/src/webview/vscode-theme.ts:203).

    **Recommendation:** No current search identity work is required. If Glide search is enabled later, its result `Item`s are display coordinates and must be generation-scoped or source-rebased.

## Claims that are correct

- The dirty map is currently display-row keyed: keys are constructed from the passed row at [use-editing.ts:109](/Users/jmb/repos/Extensions/table-viewer.worktrees/release-binaries/src/webview/use-editing.ts:109), and Glide’s row reaches `commit_edit` unchanged at [grid-shell.tsx:1368](/Users/jmb/repos/Extensions/table-viewer.worktrees/release-binaries/src/webview/grid-shell.tsx:1368).
- `serialize_csv` interprets that row component as the sequential source/data row at [serialize-csv.ts:49](/Users/jmb/repos/Extensions/table-viewer.worktrees/release-binaries/src/serialize-csv.ts:49), while save walks untransformed `src.read_rows` windows at [viewer-controller.ts:2498](/Users/jmb/repos/Extensions/table-viewer.worktrees/release-binaries/src/viewer-controller.ts:2498). This is the real silent-wrong-row defect.
- Hidden rows participate in the same source-to-display permutation as filtering at [table-transform.ts:124](/Users/jmb/repos/Extensions/table-viewer.worktrees/release-binaries/src/table-transform.ts:124).
- Existing CSV pending-edit migration is plausibly a no-op: CSV’s `rowCount` and `sourceRowCount` are equal at [csv-source.ts:139](/Users/jmb/repos/Extensions/table-viewer.worktrees/release-binaries/src/data-source/csv-source.ts:139), and the current host/webview barriers prevented valid edits from being created under transforms.
- Auto-grow is genuinely ungated on `transformed`.

Bottom line: keep the two-PR concept if desired, but PR 1 needs an edit-session-owned state model, host-side base validation, and a replacement transform/edit/save admission protocol. The row-height guard itself is not the reason PR 1 is unsafe.
tokens used
289,841
The core diagnosis is correct, but the plan is not safe to implement as written. The two-PR split is defensible in principle; PR 1 is not mergeable until its edit-state lifetime, transform/save ordering, and conflict validation are redesigned.

