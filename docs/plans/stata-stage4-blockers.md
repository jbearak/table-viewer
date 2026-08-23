# Stage 4 — Stata release blockers resolved

Stage 4 fixed four release-blocking defects in the read-only Stata data source.
The implementation lives primarily in `src/data-source/dta-source.ts`, with
comparison identity support in `src/data-source/interface.ts`,
`src/cell-display.ts`, and `src/diff-compare/`.

## Legacy expansion fields

`DtaDataSource.create` now validates release 113/114/115 expansion fields before
calling the dependency's synchronous `parse_legacy_metadata`
(`dta-source.ts:213-218`, `:808-847`). The guard rejects negative lengths,
truncation, non-advancing cursors, and more than 10,000 fields. The count limit
prevents a bounded-size file containing millions of zero-length fields from
monopolizing the extension host even though each individual cursor step is
valid.

The call-site guard intentionally duplicates the dependency's legacy header
layout. `@jbearak/dta-parser` cannot currently reject the malformed input before
its scanner hangs, and a fixed dependency release was not available for this
stage. The upstream fix is tracked as `jbearak/dta-parser#36`; once a fixed
version is released and adopted, this duplicate guard can be removed.

## Bounded strL object lookup

The GSO location index is an LRU capped at 1,024 complete entries
(`dta-source.ts:149-160`, `:641-648`). A complete index was deliberately not
retained because one boxed `Map` entry per distinct strL can consume hundreds
of MiB in addition to the file buffer.

Bounded scan checkpoints preserve efficient backward lookup after an entry is
evicted (`dta-source.ts:620-676`). Checkpoints are ordered by physical Stata
GSO traversal order — observation first, then variable — rather than by the
identity key (`variable * 2^32 + observation`). Identity and traversal order
must remain separate: ordinary files with multiple strL columns are
observation-major, so identity keys are not monotonic. The checkpoint list is
also capped and thinned as it grows, keeping auxiliary memory independent of
the number of distinct strLs.

On an index miss, a target already covered by the scanned prefix is looked up
there before the unvisited tail is scanned (`dta-source.ts:521-559`). A fallback
hit is promoted into the bounded LRU, so repeated older-range reads do not pay
the checkpoint search again.

## Binary strL identity and display

Binary type-129 GSOs now have separate display and comparison representations.
Display and clipboard surfaces receive a bounded 32-byte hexadecimal preview
such as `binary (N bytes): ...`; comparison code receives a domain-separated
SHA-256-plus-length identity through `RenderedCell.comparisonKey`
(`dta-source.ts:105-139`, `:713-726`, `:780-799`; `cell-display.ts:8-14`). A
text strL can therefore exactly equal the displayed binary preview without
colliding in row alignment or changed-cell detection.

The digest is used instead of the payload because comparison must remain
correct without materializing a two-characters-per-byte hex string. Hashing is
lazy: ordinary rendering and copying only build the fixed-size preview. Digests
are computed when comparison identity is requested and retained in a separate
bounded cache keyed by GSO content offset, so decoded-window eviction does not
immediately force expensive blobs to be rehashed.

Both `read_raw_columns` and rendered reads still pass through the shared
`resolve_cell` / `canonicalize_stata_raw` path (`dta-source.ts:364-378`,
`:450-460`). This invariant prevents fast raw consumers and rendered comparison
consumers from assigning different identities to the same Stata value.

## Regression coverage

`src/test/dta-source.test.ts` now covers the gaps that allowed these defects
through:

- a negative legacy expansion length in a child Vitest process with a generous
  60-second fail-closed hang guard;
- an adversarial run of 10,000 zero-length nonzero-type expansion fields;
- an evicted early GSO revisited while the forward scan is only partially
  advanced, including promotion back into the bounded index;
- observation-major data with two strL columns;
- a text value identical to the binary display preview but distinct in
  comparison identity; and
- a multi-MiB binary payload whose display remains bounded and whose digest is
  not computed until comparison identity is requested.

No Stage 4 release blocker remains outstanding.
