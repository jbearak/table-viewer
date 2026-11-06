# Parquet files in Table Viewer: reading and saving

Status: approved by Claude Sonnet and GPT Terra (revision 7, after six
rounds).

## Goal

Table Viewer opens `.parquet` files as read-only tables, as it opens
`.dta` files, and can save a `.dta` table as a Parquet file. A Parquet
file written by `@jbearak/dta-parser` or datakit keeps what a `.dta`
file says, and the viewer shows what it shows for `.dta`: value labels,
display formats, and `.a` to `.z` in the cells, and (new for both
formats) variable labels in the column header tooltip. A Parquet file
from other libraries (pyarrow, pandas, polars, DuckDB, arrow for R, and
so on) opens with its own types: dates, timestamps with time zones,
64-bit integers, categoricals, and binary values.

## Where things stand

- **`.dta` today.** `main` reads Stata files through
  `@jbearak/dta-parser` 1.0.0 from npm (#309). `StataReaderSource`
  (`src/data-source/dta-source.ts`) is a thin `DataSource` over a 1.0
  `DtaReader`: it caches rendered 256-row windows (8 windows, 16 MiB),
  applies value labels and display formats, reads in bounded chunks
  (64K cells) with a yield and a cancellation check between them, and
  gives binary strLs deferred identities. `DtaDataSource` opens bytes
  (`openDta`, used for `git:` URIs and compare originals) and
  `FileDtaDataSource` opens a descriptor it holds (`openDtaFile(fd)`,
  used for every `file:` view), hashes the file once, and checks the
  descriptor against the path (`physical_content_matches`).
- **Arrow, tried and removed.** #306 added read-only Arrow IPC tables
  and #308 removed them before release, unreleased. Its source
  (`git show 88735d4:src/data-source/arrow-source.ts`) decoded whole
  dictionaries and decompressed whole record-batch buffers before it
  could check them against its budgets, which dta-parser's research
  (`docs/research/parquet-typescript.md`, "What table-viewer needs")
  lists as the lessons for Parquet. Parquet's footer gives every column
  chunk's compressed and uncompressed size, its dictionary page size,
  and its statistics before anything is decoded, and the npm package
  reads page by page with a page cache.
- **The npm package.** dta-parser's ADR 0034 keeps Parquet inside
  `@jbearak/dta-parser` so that Table Viewer has one synchronous
  `TableReader` over both formats. At jbearak/dta-parser 394562f the npm
  package is 1.1.0: `DtaReader` and `ParquetReader` both implement
  `TableReader` (`info`, `variables`, `readColumns`, `readRows`,
  `readRowsAt`, `valueLabels`, `close`); `openParquetFile(fd)` reads
  through a descriptor the caller holds; `ParquetReader` keeps a page
  cache (`pageCacheBytes`, 8 MiB by default); `info` and `variables`
  give the footer (row groups, codecs, per-chunk sizes, null counts,
  min and max) before any data is read; and `writeParquet` /
  `writeParquetFile` take the same `WriteDataset` as `writeDta`. 1.1.0
  is a superset of 1.0.0 for `.dta`: the declarations add types and
  members and rename `stataKey` to `dtaKey` (the old name stays).
  Its `dist/index.js` is 1.0 MB against 1.0.0's 0.5 MB, since the wasm
  module now holds Parquet and its codecs. 1.1.0 is not on npm.

## How Table Viewer gets the 1.1 package

**A vendored tarball.** The tarball `npm pack` makes from
jbearak/dta-parser at 394562f is committed as
`vendor/dta-parser/jbearak-dta-parser-1.1.0.tgz`, and `package.json`
depends on it:

```json
"@jbearak/dta-parser": "file:vendor/dta-parser/jbearak-dta-parser-1.1.0.tgz"
```

`package-lock.json` records its sha512 integrity, so `npm ci` fails if
the file changes. `vendor/dta-parser/README.md` records the commit, the
commands that built it (`scripts/build-wasm.sh` with rustup's stable
toolchain and Homebrew LLVM, then `npm ci`, `npm run build`, and
`npm pack` in `js/`), the toolchain versions, and the tarball's sha256.

Other ways, and why not:

- **Develop against an out-of-repository tarball and hold the merge
  until 1.1.0 is on npm**, as #309 did for 1.0 (`file:../.tv-tarballs/`
  during review, `^1.0.0` before merge). That keeps `main` free of a
  vendored file, but nothing could merge until the user publishes, and
  the user asked for the work merged with publishing left to them.
- **A git dependency** on jbearak/dta-parser at a commit. The package
  lives in `js/`, which npm's git dependencies do not address without a
  `prepare` script at the root, and `npm run build` embeds a wasm module
  that must first be built with Rust and an LLVM that targets
  WebAssembly. Every `npm ci`, in CI and on contributors' machines,
  would need both.
- **A `file:` dependency on a sibling checkout** (`../dta-parser/js`).
  It only works on a machine with that checkout, built, at the right
  commit; CI has none.
- **A tarball attached to a dta-parser release.** That needs a release
  or tag of dta-parser, which is the user's to cut.

**Effect on CI.** `npm ci` installs the vendored file with no network
access for it and no Rust or LLVM. The jobs are unchanged. The
repository grows by the tarball (749 KB), once per update.

**Effect on Table Viewer's release.** The extension bundle and the
desktop bundles are built by esbuild with the package inlined (each
grows by about 0.5 MB, and PR 4's save worker is one more bundle of
about 1 MB), so neither the VSIX nor the desktop app reads the npm
registry or `vendor/` at run time. PR 1 adds `vendor/**` to
`.vscodeignore`; `electron-builder.yml` already ships only `dist/`,
`package.json`, and `LICENSE`. So that a release cannot ship an
unpublished dependency by accident, PR 1 adds
`scripts/check-release-dependencies.mjs`, which fails when any runtime
dependency in `package.json` is a `file:` dependency, with a message
saying to publish 1.1.0 and switch to it, or to remove the check to
release anyway. `release-build.yml` runs it right after `npm ci` in
each of its four jobs (`windows-validation`, `build`, `desktop`, and
`desktop-windows`), since the macOS `desktop` job does not depend on
the others; a unit test runs the script against a `package.json` with
and without a `file:` dependency. `release-publish.yml` also runs
`npm ci` for its own publishing tools, and it only publishes artifacts
from a successful Release Build run (also when dispatched by hand), so
it needs no check. This plan does not
bump the version,
tag, or release.

**When the user publishes 1.1.0.** `npm publish` of this tarball
uploads these bytes, so the registry's sha256 should match the vendored
file's; the PR that switches to `^1.1.0` checks that, or, if a
different build was published, compares the registry tarball's `dist/`
files with the vendored ones and reruns the suites below. It deletes
`vendor/dta-parser/` and the release guard.

**Licences.** 1.1's wasm module includes crates from crates.io (zstd,
snappy, LZ4, miniz, brotli, and their dependencies), and the package
ships their licences as `THIRD-PARTY-NOTICES`. Today neither the VSIX
nor the desktop app would carry it: `desktop/collect-licenses.mjs` only
picks up files named LICENSE, COPYING, or NOTICE, and the VSIX ships
only Table Viewer's own `LICENSE` and `NOTICE.md`. PR 1 makes the
desktop collector include the package's `THIRD-PARTY-NOTICES`, and a
small Node script run by the `bundle` script (not `cp`, so the Windows
jobs keep working) copies it into the VSIX as
`dist/THIRD-PARTY-NOTICES-dta-parser.txt`, with tests that both
outputs contain it.

## Opening a Parquet file

### One source over `TableReader`

`StataReaderSource` becomes `TableReaderSource`, in
`src/data-source/table-reader-source.ts`, typed over `TableReader`.
What it does today stays: the rendered-window cache, the bounded,
cancellable, chunked reads for sorting, filtering, histograms, and
compare (`read_raw_columns_async`, `read_raw_columns_indexed_async`,
`read_rows_indexed_async`), filter metadata from value labels, the
lifecycle epoch, and binary deferred identities.

The `.dta` per-cell loop stays exactly as it is. #309 tuned it (a
256-row page in 1.25 ms median on a 1,000,000-row file), so formats do
not share it through a per-cell policy. Instead the base class keeps
the `.dta` loop, and `ParquetReaderSource` overrides the methods that
turn decoded columns into cells (`decoded_window` and the raw-range
read) with a Parquet loop that handles the column kinds `.dta` never
has (bigint, dictionary, nullable text and binary, dates, timestamps,
times, and bools). Parquet-only checks and `ParquetInfo` fields
(`footerBytes`, `keyValue`, `rowGroups`, `chunks`) live in the Parquet
classes, which hold a `ParquetReader`.

| class | opens | used for |
|---|---|---|
| `DtaDataSource` | `openDta(bytes)` | `.dta` from bytes (unchanged) |
| `FileDtaDataSource` | `openDtaFile(fd)` | `.dta` on disk (unchanged) |
| `ParquetDataSource` | `openParquet(bytes, options)` | `.parquet` from bytes: `git:` URIs, compare originals |
| `FileParquetDataSource` | `openParquetFile(fd, options)` | `.parquet` on disk |

The descriptor, digest, and descriptor-versus-path checks in
`FileDtaDataSource` move to a shared helper used by both file-backed
classes, so a Parquet view reads the bytes it hashed, as a `.dta` view
does. `viewer-controller.ts` gains a `parquet_profile()` like
`dta_profile()` (`editing: false`, `prefer_file_source: true`), and
`build_source_from_buffer` dispatches `.parquet` to
`ParquetDataSource`.

The Parquet table's columns are the reader's readable variables, in
order; nested and unreadable variables are left out (see
"Warnings"). The Parquet source keeps one array mapping table column
`i` to reader variable `readable[i]`, and every read, `labels_of`,
`column_filter_metadata`, `columnNames`, and the column details go
through it; a test puts a nested column in the middle of a file.
`estimatedRowBytes` is the row groups' uncompressed bytes over the row
count.

PR 2 reruns #309's `.dta` page benchmark (200 random 256-row pages of
a 1,000,000-row file) and a sha256 of every rendered `.dta` cell on
those pages before and after the refactor, and the PR records both.

### Reads

- **Contiguous windows** go through `readColumns(columns, { start,
  count })`, as for `.dta`.
- **Sparse rows** (`read_rows_indexed`, `read_rows_indexed_async`,
  `read_raw_columns_indexed_async`) go through `readRowsAt`, which
  groups nearby rows into windows and decompresses each page once.
  `readRowsAt` merges requested rows with fewer than 64 unrequested
  rows between them into one window, with no cap on its length, and keeps every window's decoded columns until
  it returns. So the source passes it groups of requested rows whose
  first and last span at most `block_rows` rows, inclusive (at most
  256 rows for an unbounded column, below), which bounds the rows any call decodes,
  and splits the columns into batches by the per-request bounds of
  "Wide files" over that span, as contiguous reads do. The grouping is
  computed per column batch, since an unbounded column read alone uses
  256-row spans while the other batches use `block_rows`. Between calls
  it yields and checks cancellation. A test reads every 3rd row over a
  run of large values and checks each `readRowsAt` call's span and
  columns. `readRowsAt` gives a null in any column as
  `MISSING["."]`, so cells are mapped by the variable's `columnKind`:
  in a string or dictionary column (text, binary, categorical) that is
  a text null (below), and in a number or bigint column it is `.`.
- **Wide files.** The grid asks for whole rows. A Parquet page holds
  about 1 MiB of values (in files this package writes and in pyarrow's
  defaults), so a 256-row window of a wide file decompresses one page
  per column, and a page cache cannot hold one page for each of 1,000
  columns. Measured with 1.1.0 on an M4 Max, on 200,000 rows by 1,000
  columns written by `writeParquet` (286 MB) and the same data as
  `.dta` (816 MB):

  | read | `.dta` | Parquet |
  |---|---|---|
  | 256-row window of every column, sequential, median | 1.6 ms | 101 ms (no better with a 256 MiB page cache) |
  | the same, random | 2.1 ms | 221 ms |
  | 2,048-row block, 16 columns at a time, per 256 rows | | 12.8 ms |
  | every cell, 4,096-row chunks | | 9.7 s |
  | 256-row window of 30 columns | | 1.1 ms |

  On 1,000,000 rows by 26 columns a sequential window is 2.1 ms
  (`.dta`: 0.1 ms). For scale, a rendered 256-row page of the wide
  `.dta` file through today's `FileDtaDataSource` takes 93 ms median,
  most of it building and formatting 256,000 cells, so the reader's
  extra time matters most when it is a large share of that. So
  `ParquetReaderSource` decodes in blocks: it reads `block_rows` rows
  (2,048, or fewer so that a block's decoded columns are estimated at
  32 MiB or less from the footer's sizes, and at least 256), 16 columns
  at a time, and builds 256-row rendered windows from them. It keeps
  one block, evicting it before decoding the next, so at most one kept
  block and one block being built are held.

  **Counting.** Decoded data is counted per value the way the save
  counts it: 9 bytes for a number or bigint, 16 bytes plus twice the
  length for a text value, and 160 bytes plus the length for a binary
  value. PR 2's peak-RSS measurement checks those constants.

  **What the footer can bound, and what it cannot.** A read of a
  number column over `r` rows decodes 9 bytes a row, known in advance.
  For a text or binary column the footer gives only each column chunk's
  uncompressed size, and the package has no Parquet counterpart of the
  `.dta` reader's `maxStringBytes: 0`, which gives each value's length
  before its text is read. `readColumns` returns the whole range asked
  for: the package's 64 MiB budget limits each of its internal module
  calls (it splits them and refuses only a single value over 64 MiB,
  `DTA_TOO_LARGE`), not the JavaScript arrays and strings it returns. So
  the source bounds each request before it is made:

  - A batch's columns are taken while their bound fits the block's
    remaining budget. A column's bound over the rows asked for is exact
    for numbers. For a text or binary column whose chunks in range use
    only encodings that store every value's bytes (PLAIN,
    DELTA_LENGTH_BYTE_ARRAY), every decoded byte is in the chunk, so the
    bound is the sum, over the row groups those rows fall in, of 16 (or
    160) bytes a row plus twice the chunk's uncompressed size.
  - A text or binary column is **unbounded** if any chunk in range lists
    `RLE_DICTIONARY`, `PLAIN_DICTIONARY`, or `DELTA_BYTE_ARRAY` among its
    `encodings`, or has a `dictionaryPageBytes`: the package copies each
    repeated binary value into its own `Uint8Array`, a dictionary entry
    may repeat in every row, and DELTA_BYTE_ARRAY builds each value from
    the previous one's prefix, so one stored value can decode many
    times over. (The encodings are checked as well as
    `dictionaryPageBytes`, which is null when a writer leaves the
    dictionary page's offset unset.) An unbounded column is treated as
    one that does not fit.
  - A column that does not fit, or is unbounded, is read alone, for the
    rows of the window asked for (256), and its cells are rendered and
    its decoded values dropped before the next read; the block is
    marked oversized and not kept if the column did not fit, and later
    windows in it are read the same way without trying the block again.

  What is left unbounded is one text or binary column of one 256-row
  window, when its chunk is larger than the budget or uses a
  dictionary: the source cannot know that window's size before reading
  it, and those are the values the window shows. A window of 256
  one-megabyte strings decodes to about 512 MB. Reading dictionary text
  columns alone costs a module call per column per window; PR 2's
  measurement includes a file of dictionary-encoded text columns (the
  writers' default), and if it misses the pass bars the PR records that
  and the final report says so. The final report lists this, with the page-inflation
  gap below, as something the npm package could close by giving Parquet
  value lengths before their text, as it does for `.dta`.

  Raw scans (`read_raw_columns_async`) read Parquet in chunks of at
  least 2,048 rows, so a compare scan of a wide file does not reread
  each page for every 65 rows. They use the same per-request bounds,
  with a 64 MiB budget, and turn each batch into the raw cells the
  caller asked for before reading the next, so decoded columns never
  accumulate across batches; a column whose bound does not fit, or that
  is unbounded, is read alone in ranges of 256 rows.

  A test builds a file of short strings with one 256-row run of
  200 KB strings in its own row group (written with `rowGroupSize:
  256`, since the option applies to the whole file) and checks that the block over
  the run is marked oversized and not kept, that later windows in it
  read only their rows (spying on `readColumns`), that every window is
  correct, and that a scan across the run reads the large column alone.
  Another test does the same with a dictionary-encoded binary column of
  one large value repeated in every row, and another with a pyarrow
  file whose text column is DELTA_BYTE_ARRAY (`use_dictionary=False`,
  `column_encoding="DELTA_BYTE_ARRAY"`) with long shared prefixes.

  PR 2 measures the source (not just the reader) on these files and on
  a pyarrow-written wide file, with the page cache at 8, 16, and
  32 MiB, records first-window time, sequential and random medians and
  95th percentiles, and peak RSS, and sets `pageCacheBytes` to the
  smallest size within 10% of the best. Pass bars: on the 1,000,000 by
  26 file, the random 256-row page median through the source is at
  most 20 ms (a sorted or filtered view reads random pages; the reader
  alone took 5 to 6 ms); on the wide file, the sequential median is at
  most 25% above the wide `.dta` file's. If a bar is missed, the PR
  records it and the final report says so, and the follow-up is reading
  only the visible columns, which needs the grid to request column
  ranges and is not in this plan.

### Opening, and limits checked before data is decoded

Before opening, the source reads the file's last 8 bytes itself and
refuses a footer longer than 64 MiB, so the parser never reads a
larger footer. `ParquetReader` is then opened with `nested: "error"`,
`int64: "auto"`, and the measured `pageCacheBytes`. With
`nested: "error"` nested columns stay in `variables` with role
`nested`, so their names can be listed; the source always reads an
explicit list of readable columns, so they never cause an error.

Then, from the footer, before any data or value label is decoded:

| check | limit | why |
|---|---|---|
| rows | 2,000,000 | as file-backed `.dta`: row-count-sized index arrays |
| columns | 10,000 | as file-backed `.dta` |
| column chunks (columns × row groups) | 1,000,000 | statistics for all of them are parsed at once on first use of `chunks`, and kept until the reader closes; PR 2 measures the heap they hold at this limit and lowers it if that passes 64 MiB |
| the `dta` key-value entry's bytes (`info.keyValue`) | 16 MiB | value labels are parsed from it on first use |
| average uncompressed bytes per row, from the row groups | 1 MiB | as `.dta`'s per-observation limit |
| each column chunk's dictionary page (`dictionaryPageBytes`) | 16 MiB | the Arrow lesson: no dictionary is decoded before its size is checked; a chunk with a dictionary encoding but no recorded page cannot be checked here, and its column is read as unbounded (see "Wide files") |

After the first `valueLabels` call, the decoded sets that variables use
are held to the `.dta` limits (65,536 entries, 16 MiB of text). A file
over a limit fails to open with a message naming the limit, as `.dta`
does.

What the footer cannot bound: the uncompressed size of one page (the
footer gives only whole-chunk sizes) and of a dictionary page once
decompressed. The package checks every length against the file before
allocating and caps each read's decoded output at 64 MiB in its module,
reporting `DTA_TOO_LARGE` beyond it; a page that inflates far past its
chunk's recorded size is reported as corrupt or too large by the
package, not bounded by the viewer. The final report lists this as a
gap the npm package could close.

The buffered `ParquetDataSource` applies `assert_safe_sheet_shape`, as
`DtaDataSource` does: 1,000,000 rows, 256 columns, and 50,000,000
cells. That is narrower than the file-backed limits, so a diff of a
large or wide Parquet file against git fails to build its original
side, as it does for `.dta`.

**Warnings.** Columns the package does not read are left out of the
table and named in the source's `warnings`, which the viewer already
shows for xlsx and xls files: nested columns (lists, maps, structs) and
FLOAT16 or INTERVAL columns (`columnKind` null). `info.warnings` (a
damaged or newer dta profile) are shown the same way. When the
profile cannot be read at all, its labels, formats, and missing letters
are absent, so the cells show as they would for another library's
file. A file with only
such columns opens as a table with no columns and those warnings; a
test covers it.

### What each cell shows

Each cell has a raw value (the identity used by sort, filter, and
compare) and a formatted value (shown when Formatting is on, as for
`.dta`).

| Parquet column | raw | formatted |
|---|---|---|
| number with a dta-profile value label | the number | the label |
| number with a display format from the dta profile (`%td`, `%9.2f`, ...) | the number | `formatValue(value, format)`, as for `.dta` |
| number without a format (other libraries' files) | `String(value)` | the same; `formatValue` is never called with an empty format, since it rounds to 7 digits and shows NaN as `.` |
| NaN, Infinity, -Infinity (values, not missing) | `NaN`, `Infinity`, `-Infinity` | the same |
| `.` (a null in a number, bigint, date, timestamp, time, or bool column) | `.` (`stata:missing:.`) | `.`, or its label |
| `.a` to `.z` | `.a` to `.z` | the letter, or its label |
| bigint (`int64: "auto"` reads a 64-bit column as bigints unless every row group's statistics prove its values within 2^53, so also when a row group has no statistics) | the digits, `rawType` number | the same |
| bool | `1` or `0` | `true` or `false` |
| DATE (`unit` day) | days since 1970 | `2024-03-01` |
| TIMESTAMP with a time zone | the count of its unit since 1970 | `2024-03-01T09:00:00.123456-05:00[America/New_York]` |
| TIMESTAMP without a zone (a clock time) | the count | `2024-03-01T14:00:00.123456` |
| TIME | the count since midnight | `14:00:00.123456` |
| text | the text | the text |
| categorical (dictionary) | the level's text | the level's text |
| binary | as `.dta` binary strLs: a bounded hex preview and a deferred sha256 identity | the preview |
| a null in a text, categorical, or binary column | empty, `rawType` empty, comparison key `parquet:null` | empty |
| DECIMAL, precision ≤ 15 | the nearest double, as the package gives it | the same |
| DECIMAL, precision > 15 | the digits, as text | the same |

A column's Parquet type decides its formatting before any display
format does: a DATE, TIMESTAMP, or TIME column (one with a `unit`) is
formatted by its unit even if the dta profile also gives it a Stata
format such as `%td`, which counts from 1960 rather than 1970. Only
numbers without a `unit` use the display format.

A bigint and a number with the same digits have the same raw value,
so a small-valued INT64 column read as bigints (no statistics)
compares equal to the same data read as numbers; a test checks that,
and that sort and filter order raw digits beyond 2^53 correctly.

A timestamp's or time's fraction shows the digits its unit has (3 for
ms, 6 for us, 9 for ns), so values a nanosecond apart show differently.
Dates and timestamps outside a JavaScript `Date`'s range show their raw
count. Zoned timestamps are converted with `Intl.DateTimeFormat`; an
unknown zone name shows the UTC time with the zone's name and no
offset. Raw values are counts of the column's unit, so the same instant
in a millisecond column and a microsecond column compares unequal;
that is intended, since they are different columns of data.

Compare:

- **Null, empty, and `.` stay distinct.** A text null carries the
  comparison key `parquet:null`; an empty string is raw `""` with no
  key, as `.dta` strings are; a numeric null is the `.` missing
  identity. `cells_exactly_equal` treats a cell with a key and one
  without as different, so the three never match. Tests run all three
  through the compare engine and its row alignment.
- **The same data compares equal across formats.** A `.dta` file and
  the Parquet file written from it give the same raw value for every
  cell: the Parquet writer stores a byte column holding `.a` as DOUBLE
  with storage type byte, and both read back as the same number or
  missing code, and `.dta` strings are never null. A test compares the
  two through the compare engine and expects no differences.

### Labels and types in the header tooltip

- **Value labels** come from `reader.valueLabels(variable.valueLabels)`,
  as for `.dta`; `filter_metadata_from_labels` gives the filter
  checklist its labels and the categorical default.
- **Variable labels and types.** Neither format shows variable labels
  today; the column header tooltip only shows "Excel column X" for
  promoted Excel headers. PR 3 gives `SheetMeta` an optional
  per-column `columnDetails` array, built at open, and the tooltip shows
  the variable label, then the type (Stata: storage type and display
  format; Parquet: type, with Parquet's physical and logical type and
  the codec), then the value label set's name.
- **Footer statistics in the tooltip.** For a Parquet column, PR 3 adds
  a line from the footer, read without any rows: the null count, when
  every row group reports one, and the range, as "between <min> and
  <max>" (a writer may record bounds that are not values), when every
  row group reports both. Bounds are combined only for numbers,
  bigints, dates, timestamps, and times (by value) and text (by UTF-8
  bytes, the order Parquet's statistics use, and only if both bounds
  are valid text); binary bounds are not shown. They are formatted as
  the column's cells are, and a text bound longer than 64 characters is
  left out. The statistics are parsed once at open, for all columns,
  within the 1,000,000-chunk limit above. `columnDetails` crosses to the
  webview with `SheetMeta`, so its total size is capped at 1 MiB; past
  that, the remaining columns get no details line.
- **Data label and notes** are shown for neither format; that is not in
  this plan.

Histograms and filters still scan the column: bins and counts need
every value.

## Saving a `.dta` file as Parquet

**What it means.** Parquet files stay read-only in the grid, as `.dta`
files are. A new command, **Save as Parquet…**, writes an open `.dta`
file to a new Parquet file the user names, with everything the npm
package keeps from a `.dta` file: variable labels, value labels,
display formats, `.a` to `.z`, the data label, notes, characteristics,
and sort order. It writes the file as it is on disk (every row and
column in file order), not the view's sort, filter, or hidden columns.
Every `.dta` storage type has a Parquet counterpart the package reads
back as the same type, with two limits, both in the npm package:

- **A strL variable holding both text and binary values.** The writer
  makes the whole column binary, so its text values would read back as
  bytes. The worker detects such a column while reading and refuses
  the save, naming the variable.
- **Value label sets no variable uses.** The reader gives a set only by
  name and cannot list them, so only sets that variables name are
  copied. The docs say so.

The final report lists both as gaps the npm package could close.

It is offered for `.dta` only. For a Parquet source it would mostly
copy the file, and it would drop nested, FLOAT16, and INTERVAL columns
and retype DECIMAL and unsigned columns (the writer has no such types),
so it is not offered there.

**Where.**

- VS Code: the command `tableViewer.saveAsParquet` ("Table Viewer: Save
  as Parquet…"), in the Command Palette and the editor title's overflow
  menu when the active Table Viewer editor shows a `file:` `.dta` file
  (not a compare).
- Desktop: File > Save as Parquet…, enabled for a window showing a
  `.dta` file on disk.

Both open a save dialog defaulting to `<name>.parquet` beside the
source. The command goes through the viewer controller, which holds
the source's path and the digest recorded when the view opened
(`ViewerController` gains `save_as_parquet(destination, progress,
signal)`).

**Destination checks.** The destination is refused if it resolves to
the source: same `realpath`, or, if it exists, the same device and
inode as the source (hard links). An existing destination is replaced
only after the save dialog's own overwrite confirmation.

**How.** The write runs in a `worker_threads` worker
(`dist/parquet-export-worker.js`, and the same file under
`dist/desktop/` for the desktop app; a new esbuild entry in each
build), so the extension host and desktop main process stay responsive,
cancelling terminates the worker, and the wasm memory the write grows
is released when it exits. The worker gets V8 `resourceLimits` from the
memory budget below.

1. The worker opens the source, fstats it, hashes it through that
   descriptor, and stops with "the file changed since it was opened;
   reopen it and try again" if the hash differs from the view's digest.
2. It reads the metadata and checks the memory estimate (below).
3. It reads each column in ranges of at most 65,536 rows. Numeric
   columns have a known size. For a string variable it first reads the
   range with `maxStringBytes: 0`, which gives every value's stored
   length (`storedBytes`) without reading the text, adds those lengths
   to its count, and stops with the memory message if the count would
   pass the budget; only then does it read the text. The zero-bytes
   read also shows which values are binary (an empty `Uint8Array` where text
   shows `""`), so a strL mixing the two is refused here, before the
   text of the range that holds the second kind is read, and before
   anything is written. So no column, not even one large strL, is read past
   the budget. It posts progress after each column. The read loop
   (steps 2 and 3) is a function that takes a reader and a progress
   callback, so unit tests run it in-process with a spied
   `readColumns`; the worker tests cover only the worker's lifecycle
   (messages, cancel, cleanup).
4. It fstats the descriptor again; if device, inode, size, or mtime
   changed, it stops with the "changed" message. It then hashes the
   descriptor again and compares with the view's digest, so an
   in-place change during the read is caught.
5. It posts "writing", writes `writeParquetFile` to the temporary path
   the controller gave it, with the package's defaults (snappy,
   statistics, an offset index, `.a` to `.z` as tagged NaNs), and posts
   "written". `writeParquetFile` closes the file without an fsync, so
   the controller reopens the temporary file for writing (`"r+"`,
   since Windows needs write access to flush) and fsyncs it before the
   rename.

The controller owns the temporary path and the commit. It chooses the
path (`.<name>.<random>.parquet.tmp` in the destination directory)
before starting the worker. On "written", if the user has not
cancelled, it renames the temporary file over the destination and
fsyncs the directory (POSIX); from then on cancellation is ignored and
the save reports success. If the user cancels first, or the worker
exits with an error or `ERR_WORKER_OUT_OF_MEMORY`, the controller
terminates the worker, waits for it to exit, removes the temporary
file if it exists, and reports the cause. On Windows a
rename over a destination another program holds open fails; the error
says so. That path cannot be tested here (see "CI").

**Progress and cancel.** VS Code shows a cancellable progress
notification with the column count, then "Saved <name>.parquet" with
an Open action, or the error. Desktop shows a message box "Saving
<name>.parquet…" with a Cancel button, closed through its
`AbortSignal` when the save ends, followed by a "Saved" or an error box.

**Memory.** `writeParquet` takes whole columns, so the worker holds the
whole table, then the module packs each column again. The estimate,
from the variables' storage types, counts per cell 9 bytes for a
number (value and missing code); for text, 16 bytes of array slot and
string header plus twice the stored width; and for a binary strL value,
a fixed 160 bytes for its `Uint8Array` object and backing store plus
its length (the worker tells binary from text in the range read with
`maxStringBytes: 0`, before reading values). The total is doubled for
the module's copy; strL lengths come from `storedBytes` before their
text is read (step 3). The worker's V8 `resourceLimits` bound its heap,
but not typed arrays or the wasm module's memory (which the package
caps at 4 GiB); the byte count is what bounds those, and the writer's
own buffers are covered only by the doubling, which PR 4's
measurement checks. PR 4 measures peak RSS of saving four files: the
1,000,000-row, 26-variable file; the 200,000-row, 1,000-variable file;
1,000,000 rows of short binary strLs (about 16 bytes each); and 1,000
rows of 1 MB text strLs. It records each file's ratio of measured peak
to estimate, raises the per-value constants if a ratio shows the
estimate low for that kind of column, and sets the budget so that the
measured peak of an at-limit table of the worst kind stays under
2 GiB. A table over budget is refused with a message naming the limit
and suggesting datakit's `save_parquet` in R, Python, or Julia.

## Large files

- **Opening** reads the footer, which takes milliseconds at any size,
  and then the file's sha256, one asynchronous, cancellable pass that
  `.dta` views already make and that takes seconds for a file of
  several gigabytes. The `maxFileSizeMiB` confirmation applies to
  `.parquet` as to the other formats.
- **Scrolling** reads through the block cache above.
- **Sorting, filtering, and histograms** read one or a few columns in
  chunks with a yield and a cancellation check between them; within a
  chunk a read cannot be cancelled. **Compare** reads every column, in
  the larger Parquet chunks above.
- **Memory.** The wasm module's memory grows and is returned when the
  last open reader closes; closing a Parquet view closes its reader, as
  for `.dta`.
- **Over the limits** a file does not open, as for `.dta`. Showing the
  first 2,000,000 rows of a longer file is not in this plan.

## Registration

Following #306's checklist (and the unmerged `e6a7224` on the
`stage1/format-registration` branch, which registered `.parquet` before
the reader existed), `.parquet` is added to: the manifest's
`customEditors` selector (case classes, as for the others), the four
SCM menu `resourceExtname` patterns, the description and keywords, the
`maxFileSizeMiB` description, `TABLE_FILE_EXTENSION_PATTERN`,
`build_source_from_buffer`, `profile_for`, the macOS
`fileAssociations`, the NSIS installer's register and unregister
lists, `windows-file-associations.ts`, the compare dialog's
single-table formats, the welcome and preferences hints, the Homebrew
cask's description, and the READMEs and setup guides. The tests that
pin these lists are updated with them.

## Tests

Unit (vitest):

- **Fixtures.** Small files from dta-parser's `compat/parquet/fixtures/`
  at 394562f, written by other libraries from synthetic data (pyarrow
  defaults, pyarrow with nested columns, pyarrow's type table, polars,
  DuckDB, arrow for R, fastparquet), copied to
  `src/test/fixtures/parquet/` with a README naming the source commit;
  and files written at test time by `writeParquet`.
- **Other libraries' files.** Each fixture opens with the expected row
  count, column names, and warnings. Numbers, text, and nulls are
  checked against dta-parser's `compat/parquet/expected/` JSON for
  that fixture, cell by cell; dates, timestamps, decimals, and binary
  values, which that JSON records in pyarrow's forms, are checked
  through conversion rules written in the test (for example, an ISO
  string to a count of the column's unit).
- **Cells.** Every row of the table under "What each cell shows", raw
  and formatted, including NaN, a nanosecond timestamp, an unknown
  zone, and a bigint beyond 2^53.
- **Identity.** Text null, `""`, and `.` through `cells_exactly_equal`,
  the compare engine, and row alignment.
- **Parity.** `all_types_v118.dta` and `missing-values.dta`, written to
  Parquet with their labels: every rendered cell equals the `.dta`
  source's, and the compare engine finds no differences.
- **Reads.** Sparse, repeated, and reordered rows and columns match
  contiguous reads; a request for every 3rd row of a large file calls
  `readRowsAt` with at most `per_chunk` rows at a time (spied);
  cancellation between chunks throws `AbortError`; block-cache reads
  match direct reads; `physical_content_matches` detects a rewritten
  file.
- **Limits and damage.** Each limit, with a message naming it,
  including a footer length past 64 MiB and a dictionary page past
  16 MiB; a nested-only file; a truncated file and a corrupt page
  report "Corrupt Parquet file"; closing a view closes its descriptor.
- **Saving.** A `.dta` saved as Parquet reads back with every cell,
  label, and missing code; a strL mixing text and binary values is
  refused, naming the variable; the source changed before the read, and
  changed during it (the test rewrites the file when the worker posts
  its first progress message), are both refused; a destination that is
  the source by path, symlink, or hard link is refused; the mixed-strL
  refusal happens before the full-text read of the range that holds the
  binary value (spying on `readColumns`); the memory limit refuses by
  estimate, and during the read for a single strL
  column whose stored lengths pass it; cancelling at the first progress
  message and at "writing" terminates the worker and leaves no
  temporary file; cancelling after the rename reports success. Each
  test advances on a message from the worker, never on a delay.
- **Tooltip.** Column details for `.dta` and Parquet, statistics with a
  missing statistic in one row group, several row groups, binary
  bounds, text bounds whose UTF-8 and UTF-16 orders differ, a bound
  over 64 characters, and the 1 MiB cap.
- **Formatting precedence.** A DATE column with a `%td` format in its
  profile is formatted by its unit.
- Manifest, desktop module, compare dialog, welcome, licence, and
  release-guard tests.

VS Code integration (`src/test-integration`): opening a `.parquet`
fixture renders cells (in `open-formats.test.ts`, with the mixed-case
selector cases); the Save as Parquet command, with the save dialog
answered by the test, writes a file that then opens.

Desktop smoke suite (`desktop/test-smoke`, Playwright, launching
`dist/desktop/main.js` unpackaged): a new spec opens a `.parquet`
fixture from argv and checks, in the grid's accessibility table, a value
label, `.a`, a date, and a zoned timestamp, with Formatting on and off.
For saving, it opens a `.dta` fixture, replaces `dialog.showSaveDialog`
and `dialog.showMessageBox` in the main process through
`electronApp.evaluate`, clicks the File menu item by id through
`Menu.getApplicationMenu()` in the main process (no window focus
needed), waits for the "Saved" message box call the stub records, then
opens the file and checks its cells. Nothing waits a fixed delay. CI
runs only the relaunch spec from this directory, so the new spec runs
locally, before each PR's merge, and the PR comment says so. PR 4 also
packages the app once (`desktop:package:dir`) and saves from the
packaged build, to check that the worker loads from the packaged app
(adding it to `asarUnpack` if it does not).

## CI

GitHub runners are not available to this work, so each PR runs the
`ci.yml` jobs locally: the Ubuntu job (typecheck, vitest, the SQLite
probes, the Electron probes under xvfb, and the VS Code integration
tests on 1.127.0 and current) in Docker, and the macOS desktop relaunch
gates and the full desktop smoke suite on this Mac. The Windows jobs
(packaging, the portable update helper, SQLite, and durability) cannot
run here; the Windows registration changes are covered by the unit
tests that pin them, and Windows behaviour of the save's rename is
untested. Results go in a comment on each PR.

## PRs

1. **dta-parser 1.1 from a vendored tarball, and this plan.** The
   dependency, the vendor README, the licence notices in the VSIX and
   the desktop app, the release guard, and `docs/plans/parquet.md`. No
   behaviour change: proved by the full unit and integration suites,
   the desktop smoke suite, and a sha256 of every rendered cell of the
   `.dta` fixtures and of 200 random pages of two large files,
   identical under 1.0.0 and 1.1.0.
2. **Open Parquet files.** `TableReaderSource`, the Parquet sources and
   their block cache, the profile, the limits, the warnings,
   registration, docs, the tests above, the measurements, the `.dta`
   benchmark and digest, and the smoke spec's reading half.
3. **Column details in the header tooltip.** Variable labels and types
   for `.dta` and Parquet, and Parquet's footer statistics.
4. **Save as Parquet** for `.dta`: the worker, both commands, the
   dialogs, the memory budget and its measurement, docs, tests, the
   packaged-app check, and the smoke spec's saving half.

Each PR runs sol-loop before merge, is filed with how it was proved,
and is squash-merged when its gate passes.

## Not in this plan

- Editing Parquet cells or appending rows: rewriting a Parquet file in
  place would replace its row groups, codecs, and other libraries'
  metadata (such as `ARROW:schema`) with the npm package's, and lose
  the types it does not write.
- Saving Parquet, CSV, TSV, or Excel tables as Parquet, or anything as
  `.dta`.
- Showing the data label, notes, or characteristics.
- Showing the first 2,000,000 rows of a longer file.
- Reading only the visible columns of a wide file.
- Remote or HTTP Parquet (`openParquetAsync`).
- Publishing `@jbearak/dta-parser` 1.1.0 to npm, or releasing Table
  Viewer: the user's decisions.

## Review record

Judges: Claude Sonnet (`claude-sonnet-5-5`) and GPT Terra
(`gpt-6.1-terra`, reasoning effort high), each in a fresh session per
round.

**Round 1** (revision 1). Both: changes.

- Text null and `""` would compare equal; `readRowsAt` maps every null
  to `.` and merges rows without a cap. Fixed: a `parquet:null`
  comparison key, `readRowsAt` given at most `per_chunk` rows per call
  and its cells mapped by column kind.
- Wide files would scroll at about 100 ms a window, and compare scans
  would reread pages every 65 rows. Measured, and fixed with a decoded
  block cache and larger Parquet scan chunks.
- Saving a Parquet source would drop or retype columns. Fixed: Save as
  Parquet is for `.dta` sources only.
- The save checked the digest only before reading, compared paths
  rather than files, had no commit protocol against cancellation, and
  bounded memory by an estimate that omitted JavaScript and module
  copies. Fixed: a second fstat and hash after reading, realpath and
  inode checks, the controller commits by rename and ignores a later
  cancel, bytes are counted as read, and the budget is set from
  measured peak RSS with `resourceLimits` and out-of-memory handling.
- Footer limits were checked after the parser had read the footer; no
  bound on dictionaries; statistics parsed for all columns at once.
  Fixed: the footer length is read first, dictionary page and column
  chunk limits, and the gaps the footer cannot close are stated.
- `nested: "skip"` hides the names to warn about. Fixed: `nested:
  "error"` with explicit column lists.
- A per-format policy in the per-cell loop risked `.dta` speed. Fixed:
  the `.dta` loop is untouched, Parquet overrides it, and PR 2 reruns
  #309's benchmark and digest.
- No guard against releasing with a `file:` dependency, and the
  hold-the-merge option was not named. Fixed: a release-build check,
  and the option with the reason it was not chosen.
- The smoke suite runs unpackaged and only locally, and the save's
  completion and cancel tests waited on files. Fixed: stated, the menu
  item is clicked in the main process, the tests advance on worker
  messages, and PR 4 checks the packaged app once.
- Smaller points: NaN and empty formats, null in categorical and binary
  columns, unit-sensitive timestamp identity, the opening-time wording,
  the narrower buffered compare limit, the goal's mention of data
  labels, the Arrow-removal wording, bundle size, and the conversion
  rules for the expected JSON. Fixed in the text. Sonnet suggested
  deferring the footer statistics in the tooltip; they stay, with
  aggregation rules and a parsing bound, since showing what the footer
  holds without reading rows is one of the user's requirements.

**Round 2** (revision 2). Both: changes. Round 1's points were
resolved but for the save's memory bound and the wide-file memory
bound.

- The save's memory count ran after a whole column was read, and V8
  limits do not cover typed arrays or the module. Fixed: columns are
  read in ranges, string lengths come from `storedBytes` before the
  text is read, and the remaining gap (the writer's own buffers) is
  stated and measured.
- A strL mixing text and binary values reads back as binary, and
  unused value label sets cannot be listed. Fixed: the first is
  refused, naming the variable; both are stated as limits of the npm
  package.
- The worker chose the temporary path, so a cancel during the write
  could leave it behind. Fixed: the controller chooses it, and cancel
  is tested at "writing".
- The block and scan sizes were footer estimates. Fixed: decoded sizes
  are counted, an oversized block is not kept, and an oversized scan
  chunk halves the next.
- The release guard was in one job, but the macOS job builds on its
  own. Fixed: a script run in all four release jobs, with a test.
- Text bounds: compared by UTF-8 bytes, cut at 64 characters, and
  `columnDetails` capped at 1 MiB; the heap held by `chunks` is
  measured at the chunk limit.
- Smaller points: when a 64-bit column reads as bigints, the mapping
  from table columns to reader variables, `estimatedRowBytes`, a
  Parquet type winning over a Stata format, a pass bar for random
  pages of a tall file, and a Node copy step for the notices. Fixed in
  the text.

**Round 3** (revision 3). Sonnet: approve, with nits. Terra: changes.

- Counting a block's size after decoding it did not bound that read's
  peak, and halving the next scan chunk did not protect the current
  one (Terra). Fixed: the block's count is checked after each 16-column
  batch and the block dropped as soon as it passes 32 MiB, with a
  fallback that reads only the window, a batch at a time; scans turn
  each batch into raw cells before reading the next. A skewed-data
  test covers the first oversized read.
- Binary strL values cost more than the text allowance (both). Fixed:
  160 bytes per binary value plus its length, binary told from text
  before values are read, and PR 4's measurement adds a file of short
  binary strLs and one of 1 MB text strLs.
- Nits (Sonnet): `writeParquetFile` does not fsync, so the controller
  does; the publish workflow needs no guard; an unreadable dta profile
  leaves the cells as for another library's file. Fixed in the text.

**Round 4** (revision 4). Sonnet: approve, with points to fix before
PR 2. Terra: changes, one item.

- The package's 64 MiB budget limits each internal module call, not
  what `readColumns` returns, so a 16-column batch was not bounded by
  it (both). Fixed: each request is bounded before it is made, exactly
  for numbers and by twice the column chunk's uncompressed size for
  text and binary; a column that does not fit is read alone for the
  window's rows; and the one case the footer cannot bound (one text
  column of one window in a chunk larger than the budget) is stated,
  with an estimate, as a gap the npm package could close.
- The count was of payload bytes, unlike the save's (Sonnet). Fixed:
  the same per-value constants. The cache now keeps one block, evicted
  before the next is built, and remembers an oversized block.
- Nits: "the zero-bytes read" wording and a spy test; the controller
  reopens the temporary file with `"r+"` to fsync on Windows; the
  publish workflow's manual dispatch. Fixed in the text.

**Round 5** (revision 5). Sonnet: approve, with the dictionary point
(the same as Terra's first) and three smaller ones. Terra: changes, two
items.

- Dictionary-encoded binary values are copied once per row, and text
  can lose its sharing, so twice the chunk size did not bound them
  (Terra). Fixed: a text or binary column with a dictionary page is
  unbounded, read alone for at most 256 rows, and a test repeats one
  large binary value in every row.
- Sparse reads through `readRowsAt` kept every merged window's columns
  until the call returned, outside the new bounds (Terra). Fixed: row
  groups are limited by span, columns are batched by the same bounds,
  and a test checks each call.
- A spy in the test thread cannot see a worker's calls (Sonnet).
  Fixed: the read loop is a function the unit tests run in-process.
- Wording: the mixed-strL refusal comes before that range's text, not
  before any; a spliced test sentence; `rowGroupSize` is file-wide in
  the skewed-data test (Sonnet). Fixed.

**Round 6** (revision 6). Both: approve. Terra's nit (a first-to-last
difference of 256 covers 257 rows) is fixed by counting spans
inclusively. Sonnet's condition and nits are folded into revision 7,
each making a rule stricter: a text or binary column is unbounded when
its chunks list a dictionary encoding or DELTA_BYTE_ARRAY (which
decodes each value from the previous one's prefix) or record a
dictionary page, since `dictionaryPageBytes` is null when a writer
leaves its offset unset; `readRowsAt`'s merge rule is stated exactly;
and row grouping for sparse reads is computed per column batch.
