# Parquet files

Table Viewer opens `.parquet` files as read-only tables, in the VS Code
extension and in the desktop app. You can sort, filter, hide columns,
highlight cells, and compare two files, as with any other table. Table
Viewer never writes to a Parquet file.

## What you see

Each column of the file is a column of the table, in the file's order.

- **Files written from Stata data** (by `@jbearak/dta-parser` or
  datakit) keep what the `.dta` file said: value labels, display
  formats, and the missing values `.a` to `.z`. With **Formatting** on,
  cells show labels and formats; with it off, the stored values.
- **Files from other libraries** (pyarrow, pandas, polars, DuckDB, arrow
  for R, and others) show their own types:

| column | stored value (Formatting off) | shown (Formatting on) |
|---|---|---|
| number | `3.25` | `3.25` |
| 64-bit integer | every digit, also past 2^53 | the same |
| true/false | `1` or `0` | `true` or `false` |
| date | days since 1970 | `2024-03-01` |
| timestamp with a time zone | the count of its unit since 1970 | `2024-03-01T09:00:00.123456-05:00[America/New_York]` |
| timestamp without a zone | the count | `2024-03-01T14:00:00.123456` |
| time of day | the count since midnight | `14:00:00.123456` |
| text, or a categorical | the text | the text |
| binary | its size and first 32 bytes, in hex | the same |
| decimal | the number; past 15 digits, every digit as text | the same |

A timestamp shows as many fraction digits as its unit has: 3 for
milliseconds, 6 for microseconds, and 9 for nanoseconds. A value too
far from 1970 for a date shows its count.

**Empty cells.** A missing number, date, or time shows as `.`, as in
Stata. A missing text, categorical, or binary value shows as an empty
cell, and compares as different from a text value that is an empty
string.

**Columns that are not shown.** Lists, maps, and structs, and FLOAT16
and INTERVAL columns, are left out of the table, and a warning names
them when the file opens.

## Large files

Opening reads the file's footer, then hashes the file once so Table
Viewer can tell later whether it changed. Scrolling reads only the pages
the visible rows need. Sorting, filtering, and comparing read whole
columns, in chunks you can cancel between.

A file does not open when it has more than 2,000,000 rows, more than
10,000 columns, or more than 400,000 column chunks (columns times row
groups); when its footer is larger than 64 MiB, its rows average more
than 1 MiB, a dictionary page is larger than 16 MiB, or its Stata
metadata or value labels pass the same limits as for `.dta` files. The
message names the limit.

Comparing against a version in Git reads that version into memory, which
allows up to 1,000,000 rows and 256 columns, as for `.dta` files.

Wide files (hundreds of columns) scroll more slowly than the same data
as `.dta`: Parquet stores each column in compressed pages, so every
visible row needs a page from each column.
