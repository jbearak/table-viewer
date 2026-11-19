"""Parquet files from Python writers, from data made here (no dataset).
Usage: python3 make_python.py OUT_DIR"""
import datetime as dt
import decimal
import os
import sys

import duckdb
import numpy as np
import pandas as pd
import polars as pl
import pyarrow as pa
import pyarrow.parquet as pq

OUT = sys.argv[1]
N = 300
D = decimal.Decimal
rows = range(N)


def masked(values, every, offset=3):
    return [None if i % every == offset else v for i, v in zip(rows, values)]


# pandas, with its nullable and categorical types and an index, through
# pyarrow (pandas' default engine) and fastparquet.
utc = dt.timezone.utc
frame = pd.DataFrame(
    {
        "Int64": pd.array(masked([i * 3_000_000_017 - 7 for i in rows], 10), dtype="Int64"),
        "UInt8": pd.array(masked([i % 256 for i in rows], 11), dtype="UInt8"),
        "boolean": pd.array(masked([i % 3 == 0 for i in rows], 12), dtype="boolean"),
        "float": [float("nan") if i % 13 == 3 else i / 3 for i in rows],
        "string": pd.array(masked([f"wörd {i % 17}" for i in rows], 14), dtype="string"),
        "object": masked([f"object {i}" for i in rows], 15),
        "category": pd.Categorical(masked(["z", "y", "x"] * (N // 3), 16), categories=["x", "y", "z"], ordered=True),
        "datetime": pd.to_datetime(masked([dt.datetime(2022, 3, 1) + dt.timedelta(minutes=97 * i) for i in rows], 17)),
        "datetime_tz": pd.to_datetime(masked([dt.datetime(2022, 3, 1, tzinfo=utc) + dt.timedelta(hours=7 * i) for i in rows], 18)).tz_convert("Asia/Tokyo"),
    },
    index=pd.Index([f"r{i}" for i in rows], name="key"),
)
frame.to_parquet(os.path.join(OUT, "pandas_pyarrow.parquet"))
frame.to_parquet(os.path.join(OUT, "pandas_fastparquet.parquet"), engine="fastparquet")

# polars, with its own types.
pl.DataFrame(
    {
        "i16": pl.Series(masked([i * 101 - 15_000 for i in rows], 10), dtype=pl.Int16),
        "u64": pl.Series(masked([i * 61_489_146_912_365_172 % 2**64 for i in rows], 11), dtype=pl.UInt64),
        "f32": pl.Series(masked([i / 8 - 10 for i in rows], 12), dtype=pl.Float32),
        "text": pl.Series(masked([f"text {i} ✓" for i in rows], 13), dtype=pl.String),
        "cat": pl.Series(masked(["b", "a", "c"] * (N // 3), 14), dtype=pl.Categorical),
        "enum": pl.Series(masked(["low", "high", "mid"] * (N // 3), 15), dtype=pl.Enum(["low", "mid", "high"])),
        "day": pl.Series(masked([dt.date(1901, 1, 1) + dt.timedelta(days=97 * i) for i in rows], 16), dtype=pl.Date),
        "when_us": pl.Series(masked([dt.datetime(2000, 1, 1) + dt.timedelta(microseconds=123_456_789 * i) for i in rows], 17), dtype=pl.Datetime("us")),
        "when_ns_tz": pl.Series(masked([dt.datetime(2000, 1, 1) + dt.timedelta(seconds=3_607 * i) for i in rows], 18), dtype=pl.Datetime("ns")).dt.replace_time_zone("Europe/London"),
        "clock": pl.Series(masked([dt.time(i % 24, i % 60, i % 60, i * 37 % 1_000_000) for i in rows], 19), dtype=pl.Time),
        "money": pl.Series(masked([D(i * 1999 - 250_000).scaleb(-2) for i in rows], 20), dtype=pl.Decimal(12, 2)),
        "bytes": pl.Series(masked([bytes([i % 256, 0, 255]) for i in rows], 21), dtype=pl.Binary),
        "flag": pl.Series(masked([i % 2 == 1 for i in rows], 22), dtype=pl.Boolean),
    }
).write_parquet(os.path.join(OUT, "polars_types.parquet"), row_group_size=128)

# DuckDB, with its types (one row group: DuckDB's smallest is larger than
# this table): HUGEINT, UUID, ENUM, TIMESTAMPTZ, TIME, DECIMAL, BLOB.
con = duckdb.connect()
con.execute("SET TimeZone = 'UTC'")
con.execute("CREATE TYPE mood AS ENUM ('sad', 'ok', 'happy')")
con.execute(
    f"""
    COPY (
      SELECT
        CASE WHEN i % 10 = 3 THEN NULL ELSE i % 250 - 125 END::TINYINT AS tiny,
        CASE WHEN i % 11 = 3 THEN NULL ELSE (i::HUGEINT * 1000000000000000000000) - 5 END AS huge,
        CASE WHEN i % 12 = 3 THEN NULL ELSE i * 4294967 END::UBIGINT AS ubig,
        CASE WHEN i % 13 = 3 THEN NULL ELSE i / 7 END::DOUBLE AS dbl,
        CASE WHEN i % 14 = 3 THEN NULL ELSE 'duck ' || (i % 23) END AS txt,
        CASE WHEN i % 15 = 3 THEN NULL ELSE ('00000000-0000-4000-8000-' || lpad(i::VARCHAR, 12, '0'))::UUID END AS id,
        CASE WHEN i % 16 = 3 THEN NULL ELSE (['sad', 'ok', 'happy'])[i % 3 + 1]::mood END AS feeling,
        CASE WHEN i % 17 = 3 THEN NULL ELSE TIMESTAMPTZ '2001-02-03 04:05:06+00' + to_seconds(i * 86413) END AS tstz,
        CASE WHEN i % 18 = 3 THEN NULL ELSE TIMESTAMP '1999-12-31 23:59:59' + to_microseconds(i * 1234567) END AS ts,
        CASE WHEN i % 19 = 3 THEN NULL ELSE TIME '00:00:00' + to_seconds(i * 287) END AS t,
        CASE WHEN i % 20 = 3 THEN NULL ELSE DATE '1970-01-01' + (i * 40)::INTEGER END AS d,
        CASE WHEN i % 21 = 3 THEN NULL ELSE (i * 123.4567 - 9999)::DECIMAL(10, 4) END AS dec10,
        CASE WHEN i % 22 = 3 THEN NULL ELSE (i::DECIMAL(38, 6) * 123456789012345.678901) END AS dec38,
        CASE WHEN i % 23 = 3 THEN NULL ELSE ('\\x' || lpad(to_hex(i), 4, '0'))::BLOB END AS blob,
        CASE WHEN i % 24 = 3 THEN NULL ELSE i % 2 = 0 END AS flag
      FROM range({N}) t(i)
    ) TO '{os.path.join(OUT, "duckdb_types.parquet").replace("'", "''")}' (FORMAT parquet)
    """
)

# pyarrow, with what its defaults do not write: LZ4 (LZ4_RAW), large and
# view strings, durations, float16, and a dictionary of text.
pq.write_table(
    pa.table(
        {
            "large": pa.array(masked([f"large {i}" for i in rows], 10), pa.large_string()),
            "view": pa.array(masked([f"view {i % 9}" for i in rows], 11), pa.string_view()),
            "lbin": pa.array(masked([bytes([i % 256]) * 3 for i in rows], 12), pa.large_binary()),
            "dur": pa.array(masked([i * 1_000_003 for i in rows], 13), pa.duration("us")),
            "half": pa.array(masked([np.float16(i / 4 - 30) for i in rows], 14), pa.float16()),
            "dict": pa.array(masked(["one", "two", "three"] * (N // 3), 15)).dictionary_encode(),
            "i64": pa.array(masked([2**62 + i for i in rows], 16), pa.int64()),
        }
    ),
    os.path.join(OUT, "pyarrow_more.parquet"),
    compression="lz4",
    data_page_version="2.0",
    row_group_size=100,
)
print("pandas", pd.__version__, "pyarrow", pa.__version__, "polars", pl.__version__, "duckdb", duckdb.__version__)
