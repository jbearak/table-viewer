# Parquet files from Julia writers (Parquet.jl and Parquet2.jl), from data
# made here (no dataset). Usage: julia --project=ENV make_julia.jl OUT_DIR
using Dates
using DataFrames
import Parquet
import Parquet2

const OUT = ARGS[1]
const N = 300
masked(v, every, offset=3) = [i % every == offset ? missing : x for (i, x) in zip(0:N-1, v)]

r = 0:N-1
t = DataFrame(
    i32=masked(Int32.(r .* 7919 .- 1_000_000), 10),
    i64=masked(Int64.(r .* 3_000_000_001 .- 7), 11),
    f32=masked(Float32.(r ./ 8 .- 10), 12),
    f64=masked(r ./ 3 .- 50, 13),
    flag=masked(r .% 3 .== 0, 14),
    word=masked(["mot $(i % 19) ê" for i in r], 15),
    day=masked([Date(1950, 6, 15) + Day(97i) for i in r], 16),
    stamp=masked([DateTime(2010, 1, 1) + Millisecond(86_461_250i) for i in r], 17),
)
# Parquet.jl writes no dates or times.
Parquet.write_parquet(joinpath(OUT, "parquet_jl_default.parquet"), select(t, Not([:day, :stamp])))
# Parquet2.jl: its unsigned integers and Time too, in several row groups.
t2 = copy(t)
t2.u16 = masked(UInt16.((r .* 109) .% 65536), 18)
t2.clock = masked([Time(0) + Nanosecond(287_000_000_123 * i % 86_400_000_000_000) for i in r], 19)
Parquet2.writefile(joinpath(OUT, "parquet2_row_groups.parquet"), Iterators.partition(t2, 128); compression_codec=:zstd)
println("Parquet ", pkgversion(Parquet), ", Parquet2 ", pkgversion(Parquet2), ", Julia ", VERSION)
