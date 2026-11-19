# Parquet files from R writers, from data made here (no dataset).
# Usage: Rscript make_r.R OUT_DIR
# The `local` column's clock times depend on the zone R runs in: the
# fixtures were written in America/New_York.
Sys.setenv(TZ = "America/New_York")
args <- commandArgs(trailingOnly = TRUE)
out <- args[[1]]
n <- 300L
i <- seq_len(n) - 1L
na_every <- function(x, every) {
  x[i %% every == 3L] <- NA
  x
}
df <- data.frame(
  int = na_every(i * 7919L - 1000000L, 10L),
  dbl = na_every(i / 3 - 50, 11L),
  lgl = na_every(i %% 3L == 0L, 12L),
  chr = na_every(paste0("châine ", i %% 19L), 13L),
  date = na_every(as.Date("1950-06-15") + i * 97L, 14L),
  utc = na_every(as.POSIXct("2010-01-01 00:00:00", tz = "UTC") + i * 86461.25, 15L),
  local = na_every(as.POSIXct("2010-01-01 00:00:00", tz = "") + i * 3601, 16L),
  fct = na_every(factor(c("lo", "mid", "hi")[i %% 3L + 1L], levels = c("lo", "mid", "hi")), 17L),
  stringsAsFactors = FALSE
)
attr(df$local, "tzone") <- NULL
# arrow: int64 (bit64), time of day (hms), and a duration (difftime).
a <- df
a$big <- na_every(bit64::as.integer64(i) * bit64::as.integer64(30000000001) - bit64::as.integer64(7), 18L)
a$clock <- na_every(hms::hms(seconds = (i * 289L) %% 86400L), 19L)
a$wait <- na_every(as.difftime(i * 61, units = "secs"), 20L)
arrow::write_parquet(a, file.path(out, "arrow_r_types.parquet"), chunk_size = 128)
arrow::write_parquet(df, file.path(out, "arrow_r_zstd.parquet"), compression = "zstd",
                     version = "2.6", use_dictionary = FALSE)
# nanoparquet: its defaults and its other codecs and encodings.
nanoparquet::write_parquet(df, file.path(out, "nanoparquet_zstd.parquet"), compression = "zstd")
nanoparquet::write_parquet(df[names(df) != "fct"], file.path(out, "nanoparquet_gzip_plain.parquet"), compression = "gzip",
                           encoding = "PLAIN")
nanoparquet::write_parquet(df, file.path(out, "nanoparquet_row_groups.parquet"),
                           options = nanoparquet::parquet_options(num_rows_per_row_group = 64L))
cat(sprintf("arrow %s, nanoparquet %s, R %s\n", packageVersion("arrow"), packageVersion("nanoparquet"),
            getRversion()))
