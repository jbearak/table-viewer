# Arrow files

Table Viewer opens `.arrow` files as single read-only tables in both VS Code and the desktop app. Mixed-case extensions such as `.ArRoW` work too. Open them from the file picker, drag them onto the desktop welcome window, or compare them through VS Code's Source Control and Timeline views or the desktop Compare Files dialog.

Ordinary Arrow IPC files and dtatools-profile datasets are supported, with uncompressed, LZ4, or Zstandard buffers. Supported column types are booleans; signed and unsigned 8-, 16-, 32-, and 64-bit integers; Float32 and Float64; Utf8 and LargeUtf8 strings; Date32; timestamps; durations; and string dictionaries with signed integer keys. Dictionary sharing and delta batches are supported. IPC streams, nested columns, binary columns, and other unsupported types produce an error.

## Values and labels

- 64-bit integers retain every digit in the grid and raw values. Sorting and comparisons use the exact value.
- Dictionary columns display their labels and retain their original zero-based codes. Comparisons account for both the code and its label, so a relabeled category is a change.
- Arrow nulls display as blank cells. Stata missing values from a dtatools profile display as `.` or `.a` through `.z`. Empty strings, nulls, non-null NaNs, and Stata missing values retain distinct identities for comparison. The same Stata missing code compares equally in DTA and profiled Arrow files; a literal string such as `".a"` is a different value.
- Date32 values display as dates. Timestamps preserve their fractional seconds; zoned timestamps display the UTC instant with the recorded timezone annotated, while timestamps without a timezone display without a UTC suffix. Durations display their stored ticks and units. Values outside the date display range retain their ticks and epoch text. Comparisons include the recorded units and epoch.
- Profiled Float64 temporal values display their original numeric value with semantic units and any recorded epoch or timezone. This preserves fractional values without rounding them into an integer timestamp.
- Profile value labels appear in cells and categorical filters. Numeric Stata storage can use its recorded display format. Raw values remain available for comparisons.

Profile validation and canonical checksum verification are enabled. Unknown profile versions, malformed metadata, and checksum failures are reported as errors.

## Memory and cancellation

Table Viewer loads the complete file into memory before opening it. A small cache retains decoded row pages, and column projections decode the selected column buffers. Compressed selected buffers are decompressed synchronously in full, so scrolling or scanning a large compressed batch can pause the viewer. Cancellation is checked between pages; it cannot interrupt one synchronous decompression or checksum operation.

Dictionary levels and value-label maps share a 32 MiB retention budget, estimated from their text and object storage. Label maps referenced by multiple columns are shared. A read that would exceed the budget fails instead of retaining another dictionary. The parser must first materialize dictionary levels and profile metadata before Table Viewer can check their size, so this budget does not bound peak memory or total process memory.

The normal file-size confirmation threshold applies to Arrow files. Allow memory for the complete stored file as well as decoded selected buffers, dictionary levels, label maps, and row pages. Table Viewer does not currently use the parser's Node file reader for Arrow files.
