"""Read Parquet files with pyarrow and write what it reads from each to
DIR/expected/<name>.json, in the form src/test/parquet-source.test.ts
compares: each flat column's Arrow type and values. Timestamps, times
and durations are integers in their unit, dates days since 1970-01-01,
bytes (fixed-size too) lists of integers, decimals text with every digit (`format(d,
"f")`), NaN the text "NaN", dictionaries their values, and extension
types (UUID, JSON, geometry) their storage. Nested columns are listed
under "nested". A file pyarrow cannot read gives {"error": its message}.

Copied from pqparser's scripts/expected.py, which follows dta-parser's
compat/parquet/expected.py (same author, same licence).

    python3 make/expected.py DIR
"""

import glob
import json
import math
import os
import sys

import pyarrow as pa
import pyarrow.compute as pc
import pyarrow.parquet as pq


def values(col):
    t = col.type
    if isinstance(t, pa.BaseExtensionType):
        col = pa.chunked_array([c.storage for c in col.chunks], t.storage_type)
        t = t.storage_type
    if pa.types.is_dictionary(t):
        col = col.cast(t.value_type)
        t = t.value_type
    if pa.types.is_timestamp(t):
        col = pc.cast(col, pa.int64())
    elif pa.types.is_date32(t) or pa.types.is_time32(t):
        col = pc.cast(col, pa.int32())
    elif pa.types.is_time64(t) or pa.types.is_duration(t):
        col = pc.cast(col, pa.int64())
    elif pa.types.is_float16(t):
        col = pc.cast(col, pa.float64())
    out = col.to_pylist()
    if pa.types.is_decimal(t):
        out = [None if v is None else format(v, "f") for v in out]
    if pa.types.is_binary(t) or pa.types.is_large_binary(t) or pa.types.is_fixed_size_binary(t) or pa.types.is_binary_view(t):
        out = [None if v is None else list(v) for v in out]
    if pa.types.is_floating(t):
        out = ["NaN" if v is not None and math.isnan(v) else v for v in out]
    return out


def main(folder):
    out_dir = os.path.join(folder, "expected")
    os.makedirs(out_dir, exist_ok=True)
    for path in sorted(glob.glob(os.path.join(folder, "*.parquet"))):
        stem = os.path.splitext(os.path.basename(path))[0]
        try:
            table = pq.read_table(path)
            nested = [f.name for f in table.schema if pa.types.is_nested(f.type)]
            doc = {
                "rows": table.num_rows,
                "columns": [
                    {"name": f.name, "arrow_type": str(f.type), "values": values(table.column(f.name))}
                    for f in table.schema
                    if f.name not in nested
                ],
            }
            if nested:
                doc["nested"] = nested
        except Exception as e:  # noqa: BLE001 - the message is what is kept
            doc = {"error": f"{type(e).__name__}: {e}"}
        with open(os.path.join(out_dir, stem + ".json"), "w") as f:
            json.dump(doc, f, indent=None, separators=(",", ":"))
            f.write("\n")
        print(stem, "error" if "error" in doc else f"{doc['rows']} rows")


if __name__ == "__main__":
    main(sys.argv[1])
