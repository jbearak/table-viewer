# Parquet fixtures from other libraries

These files come from jbearak/dta-parser at commit 394562f,
`compat/parquet/fixtures/`, unchanged, with what pyarrow reads from each in
`expected/` (from `compat/parquet/expected/`). Their values are synthetic:
dta-parser's scripts made them, and none comes from a dataset.

| file | written by | what it covers here |
|---|---|---|
| `pyarrow_default.parquet` | pyarrow, defaults | dictionary-encoded columns, zoned and local timestamps, NaN, a categorical |
| `pyarrow_nested.parquet` | pyarrow, defaults | a list, a struct, and a map among flat columns |
| `pyarrow_types.parquet` | pyarrow, INT96 timestamps | TIME, DECIMAL up to 50 digits, unsigned integers, fixed-size binary, UUID, JSON |
| `pyarrow_delta.parquet` | pyarrow, no dictionary, `column_encoding` | DELTA_BYTE_ARRAY text and binary, DELTA_LENGTH_BYTE_ARRAY, BYTE_STREAM_SPLIT |
| `polars_default.parquet` | polars, defaults | zstd, polars' encodings |
| `duckdb_default.parquet` | DuckDB `COPY ... (FORMAT parquet)` | PLAIN_DICTIONARY, DuckDB's timestamps |
| `arrow_r_default.parquet` | arrow for R, defaults | factors, a zoned `POSIXct` |
| `fastparquet_default.parquet` | fastparquet, 250-row row groups | several row groups, unsigned 64-bit integers |

The expected JSON gives each column's Arrow type and values as pyarrow
reads them: timestamps and times as counts of their unit, dates as days
since 1970, bytes as lists of integers, decimals as text with every digit,
and NaN as the text `"NaN"`. `parquet-source.test.ts` turns these into the
cells Table Viewer shows.

dta-parser's `compat/parquet/README.md` lists the library versions that
wrote them.
