//! Parquet files from arrow-rs (the `parquet` crate's ArrowWriter), from
//! data made here (no dataset). Usage: cargo run --release -- OUT_DIR
use std::sync::Arc;

use arrow::array::*;
use arrow::datatypes::*;
use arrow::record_batch::RecordBatch;
use parquet::arrow::ArrowWriter;
use parquet::basic::{Compression, ZstdLevel};
use parquet::file::properties::{EnabledStatistics, WriterProperties, WriterVersion};

const N: i64 = 300;

fn keep(i: i64, every: i64) -> bool {
    i % every != 3
}

fn batch() -> RecordBatch {
    let r = || 0..N;
    let cols: Vec<(&str, ArrayRef)> = vec![
        ("i8", Arc::new(Int8Array::from_iter(r().map(|i| keep(i, 10).then_some((i % 250 - 125) as i8))))),
        ("i16", Arc::new(Int16Array::from_iter(r().map(|i| keep(i, 11).then_some((i * 101 - 15_000) as i16))))),
        ("i32", Arc::new(Int32Array::from_iter(r().map(|i| keep(i, 12).then_some((i * 7_919 - 1_000_000) as i32))))),
        ("i64", Arc::new(Int64Array::from_iter(r().map(|i| keep(i, 13).then_some(i * 30_000_000_001 - 7))))),
        ("u8", Arc::new(UInt8Array::from_iter(r().map(|i| keep(i, 14).then_some((i % 256) as u8))))),
        ("u32", Arc::new(UInt32Array::from_iter(r().map(|i| keep(i, 15).then_some((i * 14_316_557) as u32))))),
        ("u64", Arc::new(UInt64Array::from_iter(r().map(|i| keep(i, 16).then_some((i as u64).wrapping_mul(61_489_146_912_365_172)))))),
        ("f32", Arc::new(Float32Array::from_iter(r().map(|i| keep(i, 17).then_some(i as f32 / 8.0 - 10.0))))),
        ("f64", Arc::new(Float64Array::from_iter(r().map(|i| keep(i, 18).then_some(if i == 5 { f64::NAN } else { i as f64 / 3.0 }))))),
        ("flag", Arc::new(BooleanArray::from_iter(r().map(|i| keep(i, 19).then_some(i % 3 == 0))))),
        ("text", Arc::new(StringArray::from_iter(r().map(|i| keep(i, 20).then(|| format!("rust {} ✓", i % 23)))))),
        ("bytes", Arc::new(BinaryArray::from_iter(r().map(|i| keep(i, 21).then(|| vec![(i % 256) as u8, 0, 255]))))),
        ("day", Arc::new(Date32Array::from_iter(r().map(|i| keep(i, 22).then_some((i * 97 - 10_000) as i32))))),
        ("ts_ms_utc", Arc::new(TimestampMillisecondArray::from_iter(r().map(|i| keep(i, 23).then_some(i * 86_461_250 + 1_262_304_000_000))).with_timezone("UTC"))),
        ("ts_us_zone", Arc::new(TimestampMicrosecondArray::from_iter(r().map(|i| keep(i, 24).then_some(i * 3_601_000_007 + 1_262_304_000_000_000))).with_timezone("America/Chicago"))),
        ("ts_ns", Arc::new(TimestampNanosecondArray::from_iter(r().map(|i| keep(i, 25).then_some(i * 1_000_000_007 - 10_000_000_000))))),
        ("clock", Arc::new(Time64MicrosecondArray::from_iter(r().map(|i| keep(i, 26).then_some(i * 287_000_123 % 86_400_000_000))))),
        ("dec", Arc::new(Decimal128Array::from_iter(r().map(|i| keep(i, 27).then_some((i * 1_999 - 250_000) as i128))).with_precision_and_scale(10, 2).unwrap())),
        ("dec_wide", Arc::new(Decimal128Array::from_iter(r().map(|i| keep(i, 28).then_some((i as i128 - 150) * 123_456_789_012_345_678_901_234))).with_precision_and_scale(30, 5).unwrap())),
        ("cat", Arc::new(r().map(|i| keep(i, 29).then_some(["red", "green", "blue"][(i % 3) as usize])).collect::<DictionaryArray<Int32Type>>())),
    ];
    RecordBatch::try_from_iter(cols).unwrap()
}

fn write(path: &str, props: WriterProperties) {
    let b = batch();
    let mut w = ArrowWriter::try_new(std::fs::File::create(path).unwrap(), b.schema(), Some(props)).unwrap();
    w.write(&b).unwrap();
    w.close().unwrap();
}

fn main() {
    let out = std::env::args().nth(1).unwrap();
    write(&format!("{out}/arrow_rs_default.parquet"), WriterProperties::builder().build());
    write(
        &format!("{out}/arrow_rs_v2_zstd.parquet"),
        WriterProperties::builder()
            .set_writer_version(WriterVersion::PARQUET_2_0)
            .set_compression(Compression::ZSTD(ZstdLevel::default()))
            .set_max_row_group_row_count(Some(128))
            .set_data_page_row_count_limit(40)
            .set_statistics_enabled(EnabledStatistics::Page)
            .build(),
    );
    println!("arrow-rs (parquet crate) 60.1.0");
}
