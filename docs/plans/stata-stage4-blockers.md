# Stage 4 — Stata release blockers resolved

Stage 4 closes the release-blocking ownership, memory-bound, exactness, and
lifecycle defects in the read-only Stata and compare paths. The implementation
lives primarily in `src/data-source/dta-source.ts`, with the indexed raw-read
contract in `src/data-source/interface.ts` and comparison changes in
`src/diff-compare/`.

## Parser 0.5 encoding parity and retained workarounds

`DtaDataSource.create` passes explicit text-encoding options through to
`@jbearak/dta-parser` 0.5.0 and resolves one source encoding from
`metadata.text_encoding ?? resolve_text_encoding(metadata.format_version)`.
Parser 0.5 now owns fixed-string observation decoding for every supported
release, so the source consumes those strings directly instead of rereading and
redecoding pre-118 observation bytes. Synchronous nonbinary GSO decoding also
delegates to `decode_gso_entry` with that resolved encoding. Large text `strL`
payloads retain the local streaming decoder so payload work remains bounded and
cancellable, and the same encoding continues to drive value-label table names
and value-label text.

ISO-8859-1 is decoded directly as byte-to-code-point mapping. The Web
`TextDecoder('iso-8859-1')` alias is not used because browsers map that label to
Windows-1252; byte `0x80` must remain U+0080 under true ISO-8859-1 and become
`€` only under Windows-1252.

The local release-aware legacy expansion-field pre-scan remains. Parser 0.5
rejects malformed fields, but it does not impose a host-work bound on long
sequences of valid zero-length fields, so the source caps expansion fields at
10,000 before metadata parsing. The release-119 pointer shim also remains:
parser 0.5 uses a 2+6-byte layout for every non-117 pointer, while release 119
requires 3+5 bytes. Upstream GSO indexing and value-label parsing consume whole
sections synchronously, so the source retains its bounded lazy GSO scanner and
selective, cancellable value-label discovery and decoding.

## Indexed asynchronous raw reads

`DataSource` has an optional
`read_raw_columns_indexed_async(sheet, rows, columns, isCancelled)` capability.
The shared adapter validates the complete request before source invocation,
preserves row and column order and duplicates, and avoids source work for an
empty dimension. A native cancellable asynchronous implementation receives the
complete request once. Synchronous indexed rendered reads and contiguous
rendered range reads are split at the smaller of 4,096 rows or the rows that can
materialize at most 65,536 cells at the sheet width. Synchronous indexed and
non-indexed raw compatibility reads use the same 4,096-row and
65,536-materialized-cell bounds, accounting for selected columns when a
selective synchronous reader exists and the full sheet width when the source
must materialize complete rendered rows. Full-row raw range and indexed
fallbacks use the full sheet width as well. The adapters yield and check
cancellation between full chunks as well as between bounded groups of sparse
runs, then restore duplicate and reordered rows to the requested shape.

`DtaDataSource` implements the native capability as one sparse request. It
decodes only requested observation chunks without spanning row gaps, gathers
all selected `strL` pointers into one target set, resolves that complete set,
and restores duplicate or reordered rows and columns. Sparse compare reads
therefore reach DTA as one native request per contributing side rather than as
one request per adjacent run.

## Location-first, request-bounded GSO resolution

Stata permits GSO records in `<strls>` to appear in arbitrary physical order.
The source scans physical-file order and never infers a location from the
`(variable, observation)` identifier.

Long-lived source state is explicitly bounded:

- a 1,024-entry physical `GsoEntry` LRU;
- a 256-entry and 16 MiB decoded-GSO LRU;
- an exact compact location index, grouped into adaptive 256-identifier typed
  array pages with five payload bytes per capacity slot;
- an exact, lazily allocated seen-identifier bitmap compacted to `strL`
  variable ordinals; and
- source lifecycle and cooperative scheduler state.

The location index records every successfully forward-scanned GSO. Its dense
identifier space is `nobs × strL-column-count`, which the workbook cell ceiling
bounds to 50 million entries. Accounted typed-array payload is therefore at
most 250,000,640 bytes; page metadata is bounded to 195,313 occupied pages. The
seen-ID bitmap uses the same dense ordinals and adds at most 6,250,000 bytes,
while preserving nonadjacent duplicate detection after a physical entry leaves
the LRU.

A request target contains only identifier fields and an optional physical
`GsoEntry` location. It never retains decoded text or binary payloads. During
materialization, a request-scoped decoded memo checks the request value first,
then the bounded source decoded LRU, then the target/location followed by
physical decode. This guarantees exactly-once decode within a sparse request
even when the request has more unique `strL` values than the source LRU can
retain. The memo is discarded before the public read returns.

## One GSO transition machine

Synchronous and asynchronous GSO drivers invoke the same physical transition
function. Its phases are `cache`, `historical`, `forward`, and `done`.
Historical lookup uses the exact compact index and reads one validated physical
header per cold target instead of rescanning the visited prefix. Unseen targets
continue the lazy shared forward scan. Both phases stop as soon as the request
is resolved.

The asynchronous driver adds only scheduling and lifecycle behavior: it
consumes bounded work, awaits the shared source gate, rechecks source epoch and
caller cancellation, absorbs cache progress made by another read while
suspended, and rebases if the shared forward cursor advanced. Exact duplicate
rejection, unordered records, indexed historical lookup, and explicit exhaustion
at the physical section end are shared with the synchronous driver.

For tagged releases, the GSO payload boundary is the start of exact
`</strls>`, not the following `<value_labels>` offset. Header and content bounds
reserve the complete closing tag, so a payload cannot consume it and still be
accepted.

## Cooperative source scheduling

One source-owned cooperative gate shares a pending macrotask promise across
separately bounded counters for:

- GSO headers;
- observation cells;
- value-label discovery and decoding; and
- binary or payload bytes and jobs.

The gate is not a mutex. Synchronous reads remain callable while asynchronous
work is suspended, and concurrent asynchronous work can progress between
yields. Numeric-only asynchronous projections therefore yield and observe
cancellation even when no `strL` column is selected. Deferred binary digest
single-flight jobs retain their cache bounds while routing work accounting
through the same scheduler.

## Monotonic value-label descriptors and exact boundaries

Value-label discovery is independent of decoded-table caching. Construction
captures the immutable set of nonempty table names referenced by worksheet
variables. The source then maintains one release-aware layout, one monotonic
physical discovery cursor, descriptors only for referenced names, and a
verified-complete flag. Descriptors contain offsets and scalar layout data, not
payload slices or decoded maps.

The first physical table with a referenced name wins. Decoded-label LRU
eviction leaves the descriptor catalog and discovery cursor intact, so
re-decoding does not restart at the section beginning. A referenced name is
published as missing only after the exact section terminal has been verified.
Decoded tables remain bounded by both configured entry count and aggregate byte
limits.

Release-aware compatibility is preserved: release 105 supports fixed-eight
labels and its known offset-table compatibility form; release 108 supports
9-byte and 33-byte table names; releases 110–115 use 33-byte names. Legacy
layout probing is resumable and cancellable through the cooperative gate.

Tagged releases accept only exact `<lbl>…</lbl>` entries followed by exact
`</value_labels>` at the expected section close. Offset-table payload length
must equal `8 + 8 * count + textLength`; negative or out-of-range offsets are
rejected; and each referenced label must contain a NUL terminator inside the
declared text block.

## Binary `strL` identity and display

Binary type-129 GSOs have separate display and comparison representations.
Display and clipboard surfaces receive a bounded 32-byte hexadecimal preview,
while comparison receives a source-owned deferred SHA-256-plus-length identity.
A text `strL` can therefore equal the displayed binary preview without becoming
the same comparison value.

Hashing stays lazy and single-flight. Completed identities are retained in a
separately bounded cache keyed by content offset, and exact binary equality can
compare backing bytes cooperatively without first hashing. Rendered and raw
reads still share `resolve_cell` and `canonicalize_stata_raw`, preventing fast
raw consumers from assigning a different identity to the same Stata value.

## Exact move verification

Row hashes remain the deterministic, inexpensive move-candidate selector, but
hash equality no longer calls `claim()` directly. Tentative pairs are read in
sparse batches no larger than `HASH_READ_BATCH`, and every column is checked
with `cells_exactly_equal`, including deferred binary identities. Only a fully
equal row is claimed as an exact move.

Rejected collisions remain an addition plus a deletion for the existing
bounded similarity phase; there is no quadratic search inside a collision
bucket. The regression uses the current FNV collision `45zx` / `fpcd`, both
`2244945817`, and proves that hash equality alone creates no move.

## Compare lifecycle and metadata contribution

A compare-operation fence captures the compare wrapper epoch and caller
cancellation. Every asynchronous result is checked after awaits and immediately
before cache insertion or publication.

All genuinely two-sided operations use one paired settlement helper: both
siblings start before either is awaited, a failure cancels its peer,
`Promise.allSettled` waits for both siblings, and a substantive failure is
preferred over the peer's resulting `AbortError`. The helper is shared by diff
raw batches, aligned indexed reads, and mixed-side asynchronous filter metadata.
One-sided asynchronous operations still use the same lifecycle fence. Diff pages
run deferred exact cell identities through four workers: independent comparisons
overlap without unbounded promise fan-out, output order remains positional, and a
failure cancels and settles its peers before the operation rejects.

Filter metadata is merged by values that can actually appear in the compare
grid. Nonempty added or unmatched modified sheets use modified metadata;
nonempty appended deleted sheets use original metadata. Empty one-sided sheets
do not invoke either synchronous or asynchronous metadata providers. On a
matched sheet, modified rows contribute modified metadata, while original
metadata contributes only when a deleted row can appear. Paired rows display
modified values and do not make the original side contribute.

When both sides contribute, `categoricalCodes` is ORed. A value label survives
only when both callbacks define exactly the same string; conflicting or
one-sided labels are omitted, while equal empty strings survive through explicit
`undefined` checks. Raw values, filter identities, and comparison identities are
unchanged.

## Regression coverage and deferred stages

Focused coverage spans the indexed adapter, DTA source, row alignment, and
compare session. It includes native sparse ordering and batching, decoded and
location cache bounds, shared GSO transitions, numeric and mixed-workload
cancellation, monotonic descriptor discovery, verified missing-name
publication, cancellable legacy probing, exact label and section boundaries,
Windows-1252 versus true ISO-8859-1 behavior, the real FNV collision, sparse
exact-move verification, bounded compatibility chunks, paired sibling settlement,
lifecycle fencing, bounded deferred comparisons, empty-sheet suppression, and
contribution-aware label merging. Asynchronous tests poll observable state with
`vi.waitFor`; no fixed-delay or fixed-turn synchronization remains in the
Stage 4 tests touched by this tranche.

Stage 5 removed the obsolete pre-118 fixed-string redecode and synchronous
non-UTF-8 text-GSO decoder while retaining the objectively necessary bounded and
release-specific compatibility paths above.

Stage 6 resolves `jbearak/table-viewer#277` in the generic source path. One
immutable column analysis now carries normalized raw values, exact bounded
filter identities, raw-type classification, numeric summary, and bounded
distinct facts to both transforms and histograms. Numeric histogram bins iterate
that request-local analysis rather than rereading the source, and completed
analyses are reused across histogram and transform requests. Source-analysis
retention is bounded by both row-aligned slots and conservative retained bytes;
completed histogram results use a separate byte-bounded LRU. Both caches remain
view-generation independent and are cleared on source adoption and disposal.
Generic non-Stata regressions cover both request orders, date and boolean raw
classification on cache hits, cancellation-safe publication, per-entry rejection,
aggregate LRU eviction, and independent completed-result eviction. No DTA
production path, `DataSource` contract, protocol, UI, or rendered-grid read was
changed for Stage 6.
