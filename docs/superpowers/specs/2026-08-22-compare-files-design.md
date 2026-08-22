# Compare Files — design

Feature: `File → Compare Files…` opens a read-only window comparing two
arbitrary spreadsheets. Mockups: `docs/mockups/compare-files.html`.

## What already exists

`src/diff-compare/` already unifies two `DataSource`s into one grid, and the
renderer already paints the result. `attach_viewer` takes
`options.compare.originalUri` and forces read-only at the host level
(`src/viewer-controller.ts:958`). Reusing all of it is the point of this design.

What does **not** exist is row *alignment*. `diff_row_window`
(`compare-source.ts:213`) compares row N to row N; `added`/`deleted` only ever
means "past the end of the shorter side". Inserting one row near the top of a
file reports every row below it as changed. That is acceptable for the Git
working-tree diff it was written for — in-place edits stay in place — and wrong
for two arbitrary files.

So the new engine work is alignment, and the counts and the "only changed rows"
filter fall out of the same pass.

## The seam: an explicit alignment value

Introduce a row alignment as *data*, and let `CompareDataSource` consume it.

```ts
// src/diff-compare/row-alignment.ts  (new, pure)

/** One unified grid row. Exactly one side may be -1, never both. */
export interface AlignedRow {
    readonly original: number;   // -1 = row absent from the original (added)
    readonly modified: number;   // -1 = row absent from the modified (deleted)
}

export interface SheetAlignment {
    readonly rows: readonly AlignedRow[];
    readonly addedRows: number;
    readonly deletedRows: number;
    readonly changedRows: number;
    readonly changedCells: number;
    /** True when the aligner hit its effort cap and fell back to positional. */
    readonly degraded: boolean;
}
```

The current positional behaviour is exactly the identity alignment
(`rows[i] = {original: i, modified: i}`, clamped by each side's row count), so
this generalises rather than replaces. `CompareDataSource` takes a
`SheetAlignment` per matched sheet and resolves `meta()` row counts,
`read_rows`, `read_rows_indexed`, `source_row_indices` and `diff_rows` through
it, instead of through the `Math.max` row padding it uses today.

### The Git diff is aligned too

An earlier draft kept the existing lazy positional path for the Git SCM diff and
used alignment only for Compare Files. That was wrong, on the evidence of using
it: the positional diff reports a moved row as a screenful of changed cells,
which is the single most frustrating thing it does — and moving rows is ordinary
editing, not an edge case.

The cost argument for keeping it does not survive scrutiny either. With the
common prefix and suffix trimmed first, a typical working-tree edit — a few
cells changed in place — aligns in near-linear time and yields the *identical*
result to the positional diff. The scan the lazy path avoids is cheap in exactly
the case the lazy path is good at, and the alignment is what rescues the case it
is bad at. Both sides are bounded by `maxFileSizeMiB` (256 MiB by default), so
the worst case is bounded.

So there is one compare path. `diff_row_window`'s positional scan survives only
as the degraded fallback when the aligner hits its effort cap, and
`CompareDataSource` no longer has a mode without an alignment. One behaviour to
reason about, one to test, and the Git panel gets the fix as a side effect.

## The aligner

`align_sheet(original, modified, pairing, options)` in the new module:

1. **Hash rows.** One streaming pass per side over the row window, hashing each
   row's raw cell text (the same `get_raw_cell_text` the diff already uses, so
   alignment and cell-diff agree on what a row *is*). Yields two `Uint32Array`s
   — 4 bytes/row, so ~8 MB for two million-row sheets.
2. **Trim the common prefix and suffix.** Linear, and on realistic edits it
   removes almost everything before the expensive step runs.
3. **Myers diff over the hashes** for the remaining middle, with equality
   confirmed by re-reading the two candidate rows only on hash collision.
   Myers is O(ND) in the number of *differences*, which is why two similar
   million-row files align fast.
4. **Cap the effort.** When D exceeds the cap, stop and return the identity
   alignment with `degraded: true`. This is mockup 6. The cap is charged
   against the middle-snake search itself rather than checked once a snake
   completes: checking afterwards made the capped path *slower* than the
   uncapped one, because it paid the full cost and then discarded the answer.
5. **Count while walking**, so the counts cost nothing extra.

The diff is Myers' **linear-space** refinement — recurse on the middle snake —
not the textbook version that records one frontier per edit distance. That
distinction is not an optimisation: the textbook trace is O(D²), which at the
original 100,000 cap works out to tens of gigabytes, so two dissimilar files
exhausted memory *instead of* reaching the graceful degradation above. Memory
is now O(N+M). Two unrelated 10,000-row files, which previously needed roughly
3 GB, align in about 0.5 s with no measurable heap growth.

Reaching the cap costs time quadratic in the cap, so the cap is really a budget
for the answer "these files do not correspond": two unrelated 50,000-row files
degrade in about 0.2 s at 10,000 and about 1.6 s at 40,000. The default is
**20,000** — far past any edit still worth calling a revision, and about half a
second to say so.

Measured on in-memory fixtures: 200,000 rows with ten scattered cell edits plus
one insert and one delete aligns in **271 ms**. These figures are recorded here
rather than asserted in a test — a timing assertion is a CI flake already
written (CLAUDE.md). What *is* asserted is that unrelated files complete at
all, which is the property the rewrite exists for.

Async and cancellable, checkpointing on the same cadence as
`compute_transform` (`SCAN_ROWS_PER_CHECKPOINT`, `table-transform.ts:25`) so the
window stays responsive and Cancel is honoured promptly.

## The "only changed rows" filter

The alignment yields, per sheet, the list of grid rows that are added, deleted,
or have ≥1 changed cell — a display-row → source-row index list. That is
precisely `TransformResult.indices` (`table-transform.ts:36`). So the filter is
expressed through the existing transform layer and composes with sorting and
column filters for free, rather than becoming a special case in the grid.

**Not shipped from mockup 7:** preserved source row numbers and the
"N unchanged rows hidden" gap markers. Riding the shared transform layer is
what makes the filter compose, and that layer numbers rows by display position
for every other filter in the viewer — so honouring the mockup here would mean
either a compare-only fork of the row-marker path or changing how every filter
in the app numbers its rows. The second is a product decision beyond this
feature. Worth revisiting: the mockup's argument (a filtered row should stay
findable in the real file) applies just as well to an ordinary column filter,
which suggests fixing it once, for everything, rather than here.

## Host and UI

Because the Git panel now aligns too, `attach_viewer`'s existing compare path
gains the async alignment step: the panel opens into the same progress state as
mockup 5 rather than painting rows immediately. On a normal working-tree edit
that step is short, but it is not zero, and it must be cancellable.

| Concern | Where |
|---|---|
| Menu item | `desktop/main/main.ts`, under `Open…` |
| Dialog window | new `desktop/renderer/compare.html` + `compare.ts`, modelled on `prefs.*` |
| IPC | new `compare:*` channels in `desktop/shared/ipc.ts` |
| Window creation | `desktop/main/viewer-windows.ts` (`open_comparison`) — pass `options.compare` |
| Progress / degraded banner | new snapshot fields beside `gitCompare` |

`editing_supported` is already false whenever `options.compare` is set, so the
read-only guarantee needs no new enforcement.

## Build sequence

1. `row-alignment.ts` + unit tests (pure, no host) — inserts, deletes, moves,
   collisions, the effort cap, the counts.
2. `CompareDataSource` resolves through the alignment. Existing compare tests
   that assert *positional* added/deleted bands will legitimately change — a
   moved row is no longer a wall of changed cells. Each such change is reviewed
   as a fix, not absorbed silently.
3. Transform integration for the filter; counts onto the snapshot.
4. Desktop dialog, menu item, IPC, window wiring.
5. Progress + Cancel + degraded banner.
6. Smoke test: compare two fixtures, assert counts and the filter.

Steps 1–3 are host-agnostic and testable with in-memory fixtures; only 4–6 need
Electron.
