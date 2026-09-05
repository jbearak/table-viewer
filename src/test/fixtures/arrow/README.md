# Arrow interoperability fixtures

Copied from `@jbearak/dta-parser` 0.7.0, dta-tools merge commit
`75bf5ec88c6e6fde090f07a8684f9916ff48e34c`.

The canonical generator is
`r-package/dtatools/src/dta-tools/examples/typescript_arrow_fixtures.rs` in
https://github.com/jbearak/dta-tools.
It writes Arrow IPC using Apache Arrow Rust 59.2.0 and the dtatools writer,
then verifies each output with the Rust reader and profile checksums enabled.

The plain files contain 26 supported physical types across two record batches.
The profile files include all Stata missing codes, value labels, notes,
characteristics, an ordered dictionary, and Float64 temporal fallbacks.
Each group includes uncompressed, LZ4 Frame, and Zstandard files. The remaining
files exercise dictionary deltas and a typed empty dataset.

`missing-values.dta` is copied unchanged from `tests/fixtures/dta/missing_values.dta`
at the same parser commit. The cross-format comparison test fills its byte
column with all 27 Stata missing codes in memory, then opens those bytes through
both buffered and file-backed readers alongside the profiled Arrow fixture.
