# Parquet: PR 2's measurements

Measured on an Apple silicon Mac with Node 26.12.1 and
`@jbearak/dta-parser` 1.1.0 (the vendored tarball), on 2026-11-06. Each
row is one process, so its peak RSS is its own. The scripts are in
`benchmarks/parquet/`; bundle each with esbuild (`--bundle
--platform=node --packages=external`) inside the repository.

## Files

| file | rows × columns | size | what it is |
|---|---|---|---|
| `long.parquet`, `long.dta` | 1,000,000 × 26 | 37 MB, 106 MB | numbers with value labels, `.a` to `.z`, `%td` dates, and two text columns; written by `writeParquetFile` and `writeDtaFile` from the same data |
| `wide.parquet`, `wide.dta` | 200,000 × 1,000 | 286 MB, 816 MB | the same kinds of columns, 1,000 of them |
| `dict.parquet` | 200,000 × 100 | 28 MB | 50 text columns of 20 distinct values each, dictionary-encoded (`RLE_DICTIONARY`, as other libraries write text by default), and 50 doubles (`gen-dictionary-text.mjs`) |

A pyarrow-written wide file was not measured: this machine's `python3`
has no pyarrow, and installing it was out of scope. The fixtures from
other libraries are covered by the unit tests, not timed.

## Through the source

`source-bench.ts`: open (footer only, no digest), the first 256-row
window, 200 sequential 256-row pages, 200 random 256-row pages (a
contiguous window at a random start), and 256 random rows read
together, as a sorted or filtered view reads a page. Times in ms.

| file | page cache | open | first window | sequential median / p95 | random median / p95 | 256 random rows, median | peak RSS |
|---|---|---|---|---|---|---|---|
| `long.dta` | | 2.6 | 4.1 | 1.16 / 2.18 | 2.26 / 3.88 | 4.0 | 220 MiB |
| `long.parquet` | 8 MiB | 6.0 | 9.3 | 0.54 / 4.23 | 8.08 / 16.38 | 1,683 | 330 MiB |
| `long.parquet` | 16 MiB | 6.1 | 9.6 | 0.54 / 3.28 | 7.77 / 16.37 | 1,583 | 353 MiB |
| `long.parquet` | 32 MiB | 6.2 | 10.4 | 0.57 / 3.23 | 7.98 / 15.87 | 1,611 | 377 MiB |
| `wide.dta` | | 5.4 | 65.7 | 47.62 / 56.84 | 96.93 / 116.07 | | 426 MiB |
| `wide.parquet` | 8 MiB | 14.1 | 171.9 | 26.85 / 141.59 | 300.24 / 563.62 | | 452 MiB |
| `wide.parquet` | 16 MiB | 12.6 | 112.3 | 26.52 / 143.58 | 305.19 / 590.48 | | 477 MiB |
| `wide.parquet` | 32 MiB | 13.1 | 120.9 | 24.02 / 140.22 | 312.26 / 593.50 | | 484 MiB |
| `dict.parquet` | 8 MiB | 5.4 | 19.9 | 5.15 / 14.38 | 33.63 / 52.10 | 4,837 | 402 MiB |
| `dict.parquet` | 16 MiB | 5.2 | 19.3 | 5.19 / 15.05 | 33.33 / 51.19 | 4,788 | 419 MiB |
| `dict.parquet` | 32 MiB | 5.4 | 20.2 | 5.09 / 10.99 | 28.45 / 47.08 | 4,906 | 448 MiB |

A second run of `dict.parquet` and `wide.parquet` (no sparse pages),
to check the page-cache choice:

| file | page cache | sequential median | random median | peak RSS |
|---|---|---|---|---|
| `dict.parquet` | 8 MiB | 4.99 | 33.68 | 324 MiB |
| `dict.parquet` | 16 MiB | 5.13 | 33.24 | 349 MiB |
| `dict.parquet` | 32 MiB | 5.08 | 27.33 | 340 MiB |
| `wide.parquet` | 8 MiB | 29.08 | 306.37 | 505 MiB |
| `wide.parquet` | 16 MiB | 25.40 | 302.83 | 440 MiB |
| `wide.parquet` | 32 MiB | 25.18 | 307.68 | 521 MiB |

Every file chose 2,048-row blocks.

**Page cache: 32 MiB.** The rule was the smallest size within 10% of the
best. On `long.parquet` the three sizes are within noise. On
`dict.parquet` the random median at 32 MiB was 27 to 28 ms in both runs
against 33 ms at 8 and 16 MiB, 18% slower. On `wide.parquet` sequential
pages were fastest at 32 MiB in the first run (24.0 against 26.9 at
8 MiB) and tied with 16 MiB in the second. So `PARQUET_PAGE_CACHE_BYTES`
is 32 MiB, for at most 50 MiB more peak RSS than 8 MiB.

## Pass bars

| bar | measured | result |
|---|---|---|
| `long.parquet`, random 256-row page median through the source, at most 20 ms | 7.8 to 8.1 ms | passes |
| `wide.parquet`, sequential median at most 25% above `wide.dta`'s (47.6 ms, so at most 59.5 ms) | 24.0 to 29.1 ms | passes: faster than `.dta` |

## What the bars do not cover

- **Sorted and filtered views of a large file are slow.** A sorted or
  filtered view reads scattered rows, not a contiguous window: 256 random
  rows of `long.parquet` take 1.6 to 1.7 s through the source (`.dta`:
  4 ms), and 4.8 s for `dict.parquet`. This is the reader's own cost:
  `ParquetReader.readRowsAt` of the same 256 rows and all 26 columns,
  with no source involved, took 1,742 ms. Each random row decompresses
  and decodes one page per column, and a page holds about 1 MiB of
  values; a page cache cannot hold a page of every column of a file this
  size. A view sorted on a column of a 1,000,000-row file is usable only
  near rows that sort together. The npm package could narrow this by
  decoding only the rows asked for within a page where the encoding
  allows it (PLAIN, and BYTE_STREAM_SPLIT, have fixed-width values), or
  by writing smaller pages.
- **Random pages of a wide file.** A random page of `wide.parquet` takes
  about 300 ms (`.dta`: 97 ms): a jump decodes a new 2,048-row block of
  1,000 columns. Sequential scrolling is faster than `.dta`; jumping is
  three times slower. Reading only the visible columns (not in this
  plan) is the follow-up.
- **Dictionary-encoded text** is read alone for each window, a module
  call per column per window: on `dict.parquet` a random page is 28 to
  34 ms, with 50 such columns. A sequential page is 5 ms.

## Memory

**The column-chunk limit is 400,000, not 1,000,000.** `chunk-heap.mjs`
writes a file of one-row row groups and measures the heap the parsed
statistics hold once `chunks` is first read (`--expose-gc`, heap after
minus before):

| chunks | footer | parse | heap held |
|---|---|---|---|
| 100,000 (100 × 1,000) | 6.1 MiB | 100 ms | 15.3 MiB |
| 400,000 (400 × 1,000) | 24.7 MiB | 380 ms | 61.0 MiB |
| 1,000,000 (1,000 × 1,000) | 62 MiB | 962 ms | 152.4 MiB |

At the plan's 1,000,000 the heap passes 64 MiB, so the limit is lowered
to 400,000 (61 MiB).

**Counting constants.** `block-memory.ts` reads one window and compares
the heap and array buffers a kept block adds with the bytes the source
counted for it:

| block (2,048 rows) | counted | measured |
|---|---|---|
| `wide.parquet`, 1,000 number columns | 16.2 MiB | 15.4 MiB |
| 16 plain text columns of distinct 140-byte strings | 8.7 MiB | 5.8 MiB |
| 16 binary columns of distinct 16-byte values, counted at 160 bytes a value | 5.6 MiB | 11.1 MiB |
| the same, counted at 544 bytes a value | 17.6 MiB | 11.1 MiB |

Numbers (9 bytes a value) and text (16 bytes plus twice the length, plus
the chunk) hold. The plan's 160 bytes for a binary value was low: 32,768
copies of 16 bytes, made as the package makes them (`slice` of a larger
array), took 240 bytes each of heap and array buffers and 549 bytes each
of RSS. The source counts 544 bytes plus the length. PR 4's save
estimate uses the same constant and should start from this.

`long.parquet` and `dict.parquet` keep almost nothing in their blocks
(0.4 and 0.9 MiB counted): their text columns are dictionary-encoded and
read alone for each window.

## `.dta` before and after

`dta-digest.ts`: #309's page benchmark (200 random 256-row pages,
seeded) with a sha256 of every rendered cell (`raw`, `formatted`,
`rawType`, `comparisonKey`, `rawByteLength`) on those pages and on the
two `.dta` fixtures, buffered and file-backed. Before is 7ffa705 (PR 1);
after is this branch. Three interleaved runs each:

| | before | after |
|---|---|---|
| `all_types_v118.dta` (buffered and file) | `3731a25a…ee41ad9f` | `3731a25a…ee41ad9f` |
| `missing-values.dta` (buffered and file) | `6f7e2af2…6d751a` | `6f7e2af2…6d751a` |
| `long.dta`, 200 pages | `03be66ae…53bb9bf` | `03be66ae…53bb9bf` |
| `wide.dta`, 200 pages | `e41eec97…f982453e` | `e41eec97…f982453e` |
| `long.dta` median | 2.28 to 2.39 ms | 2.29 to 2.34 ms |
| `wide.dta` median | 92.9 to 98.8 ms | 92.2 to 96.0 ms |

The digests match those PR 1 recorded for 1.0.0 and 1.1.0.

Full digests:

    all_types_v118.dta  3731a25a503d0140d05f1f10ca3e70c5ad03a782f5ca0791135eb522ee41ad9f
    missing-values.dta  6f7e2af273d1c822ceae9c2105a411f501181ef2836a28e06205366fc26d751a
    long.dta pages      03be66ae7d25f57b02db3bd3aa7a25b3cc50d1018688bccc91d237e3753bb9bf
    wide.dta pages      e41eec97ef4f4c8ff7ea0d8994af0f6bb182e6a169d925d05560a24ef982453e
