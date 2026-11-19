# Parquet fixtures from other libraries

`parquet-source.test.ts` opens every file here as Table Viewer does and
checks each cell against what pyarrow reads from the file (`expected/`).
Every value is synthetic: scripts made each one, and none comes from a
dataset. `expected/` gives each column's Arrow type and values as pyarrow
reads them: timestamps, times and durations as counts of their unit,
dates as days since 1970, bytes as lists of integers, decimals as text
with every digit, and NaN as the text `"NaN"`.

## From dta-parser

These come from jbearak/dta-parser's `compat/parquet/fixtures/`
(commits 394562f and 0ab136d, by way of pqparser's
`test/fixtures/compat/`), unchanged, with their `expected/` files.
dta-parser's `compat/parquet/README.md` lists the scripts and library
versions that wrote them.

| file | written by | what it covers |
|---|---|---|
| `pyarrow_default` | pyarrow, defaults | dictionary-encoded columns, zoned and local timestamps, NaN, a categorical |
| `pyarrow_v2_pages` | pyarrow, data page v2 | data page v2 |
| `pyarrow_gzip` | pyarrow, gzip | gzip |
| `pyarrow_brotli` | pyarrow, brotli | brotli |
| `pyarrow_small_pages` | pyarrow, zstd, small row groups and pages, offset index | many pages, an offset index |
| `pyarrow_plain` | pyarrow, no dictionary, no compression | PLAIN only |
| `pyarrow_nested` | pyarrow, defaults | a list, a struct, and a map among flat columns |
| `pyarrow_types`, `pyarrow_types_v2` | pyarrow | INT96, TIME, DECIMAL up to 50 digits (in FIXED_LEN_BYTE_ARRAY, INT32 and INT64), unsigned integers, fixed-size binary, UUID, JSON |
| `pyarrow_delta`, `pyarrow_delta_v2` | pyarrow, `column_encoding` | DELTA_BINARY_PACKED, DELTA_BYTE_ARRAY, DELTA_LENGTH_BYTE_ARRAY, BYTE_STREAM_SPLIT |
| `polars_default`, `polars_zstd` | polars | zstd, polars' encodings, row groups |
| `duckdb_default` | DuckDB `COPY ... (FORMAT parquet)` | PLAIN_DICTIONARY, DuckDB's timestamps |
| `arrow_r_default` | arrow for R, defaults | factors, a zoned `POSIXct` |
| `nanoparquet_default` | nanoparquet for R, defaults | nanoparquet's encodings |
| `fastparquet_default` | fastparquet, 200-row row groups | row groups, unsigned 64-bit integers |
| `fastparquet_int96_brotli` | fastparquet, INT96, brotli | INT96 and brotli from another writer |
| `parquet2_default`, `parquet2_zstd_pages`, `parquet2_brotli` | Parquet2.jl (Julia) | Julia's types: unsigned integers, `Time`, `DateTime`, a `Dec64` decimal; snappy, zstd, brotli |
| `hyparquet_default`, `hyparquet_delta` | hyparquet-writer (JavaScript) | DECIMAL in a BYTE_ARRAY, ENUM, UINT_32, JSON, UUID; DELTA and BYTE_STREAM_SPLIT |

pyarrow reads an ENUM column as bytes; Table Viewer shows the text it
holds, and the test compares the two so.

## From the scripts in `make/`

Written on 2026-11-18 from data the scripts make, then
`python3 make/expected.py .` (pyarrow 26.0.1) wrote `expected/`.

| file | written by | what it covers |
|---|---|---|
| `pandas_pyarrow` | pandas 3.1.1 `to_parquet` (pyarrow) | pandas' nullable `Int64`, `UInt8` and `boolean`, `string`, an ordered categorical, naive and zoned datetimes, a text index |
| `pandas_fastparquet` | pandas 3.1.1 `to_parquet(engine="fastparquet")`, fastparquet 2026.9.0 | the same frame through fastparquet |
| `polars_types` | polars 2.1.0, 128-row row groups | `Categorical`, `Enum`, `Decimal`, `Time`, zoned nanosecond `Datetime`, `UInt64`, `Binary` |
| `duckdb_types` | DuckDB 2.0.0, one 300-row row group | `HUGEINT`, `UBIGINT`, `UUID`, an `ENUM` type, `TIMESTAMPTZ`, `TIME`, `DECIMAL(38, 12)`, `BLOB` |
| `pyarrow_more` | pyarrow 26.0.1, LZ4, data page v2 | large and view strings, large binary, a duration, FLOAT16, a dictionary of text, 64-bit integers past 2^53 |
| `arrow_r_types` | arrow 26.0.0 for R, 128-row row groups | `integer64`, `hms` time of day, `difftime`, local and zoned `POSIXct`, `Date`, factors |
| `arrow_r_zstd` | arrow 26.0.0 for R, zstd, no dictionary | the same without dictionary pages |
| `nanoparquet_zstd`, `nanoparquet_gzip_plain`, `nanoparquet_row_groups` | nanoparquet 0.5.2 for R | zstd; gzip with PLAIN encoding; 64-row row groups |
| `parquet_jl_default` | Parquet.jl 0.8.6 (Julia 1.13.3) | Parquet.jl's encodings (it writes no dates) |
| `parquet2_row_groups` | Parquet2.jl 0.2.37, zstd | several row groups, `UInt16`, `Time` in nanoseconds |
| `arrow_rs_default` | arrow-rs (the Rust `parquet` crate) 60.1.0, defaults | Rust's Arrow types: signed and unsigned integers, zoned and local timestamps, `Time64`, decimals of 10 and 30 digits, a dictionary |
| `arrow_rs_v2_zstd` | arrow-rs 60.1.0, Parquet 2.0, zstd, 128-row row groups, 40-row pages, page statistics | the same in pages v2 |
| `arrow_go_default` | arrow-go v18.9.0 `pqarrow` (Go), 128-row row groups | Go's Arrow writer: `uint16`, `date32`, a zoned timestamp, `decimal128(12, 3)` |
| `parquet_go_default` | parquet-go v0.32.1 (Go) | a struct-tagged writer: optional fields, a millisecond timestamp, a dictionary column |

To write them again, each script takes the folder to write into (an
absolute path, made beforehand; from `src/test/fixtures/parquet/`):

    python3 make/make_python.py OUT            # pyarrow, pandas, fastparquet, polars, duckdb
    Rscript make/make_r.R OUT                  # arrow, nanoparquet, bit64, hms
    julia --project=ENV make/make_julia.jl OUT # ENV with Parquet, Parquet2, DataFrames
    cargo run --release --manifest-path make/rust/Cargo.toml -- OUT
    (cd make/go && go run . OUT)
    python3 make/expected.py OUT

## From Apache parquet-testing

`parquet-testing/` holds 20 files from
[apache/parquet-testing](https://github.com/apache/parquet-testing)
`data/` at commit 0e00127 (2026-11-16), unchanged, under the Apache
License 2.0 (`parquet-testing/LICENSE.txt`); that repository's
`data/README.md` describes them. They cover what other writers here do
not: files from Impala, Hive, Spark and older parquet-mr and parquet-rs
releases, Hadoop-framed LZ4, DECIMAL in BYTE_ARRAY and fixed-length
bytes, FLOAT16, an annotation that does not fit its type (UUID on an
INT32, shown as its integers with a warning), a logical type newer than
the reader, a footer that puts a dictionary page at byte 0, and a footer
that counts no rows. `parquet-testing/expected/` is what pyarrow reads.

`int96_from_spark` has INT96 timestamps from 9999 and 290000, which
nanoseconds since 1970 cannot hold; the test checks that Table Viewer
says so (pyarrow shows wrong dates).

pqparser's own tests read all 70 files of that corpus.
