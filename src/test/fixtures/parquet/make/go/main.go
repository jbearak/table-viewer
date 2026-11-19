// Parquet files from Go writers (arrow-go's pqarrow and parquet-go), from
// data made here (no dataset). Usage: go run . OUT_DIR
package main

import (
	"fmt"
	"os"
	"path/filepath"
	"time"

	"github.com/apache/arrow-go/v18/arrow"
	"github.com/apache/arrow-go/v18/arrow/array"
	"github.com/apache/arrow-go/v18/arrow/memory"
	"github.com/apache/arrow-go/v18/parquet"
	"github.com/apache/arrow-go/v18/parquet/compress"
	"github.com/apache/arrow-go/v18/parquet/pqarrow"
	pgo "github.com/parquet-go/parquet-go"
)

const n = 300

func keep(i, every int) bool { return i%every != 3 }

func arrowGo(out string) {
	mem := memory.DefaultAllocator
	schema := arrow.NewSchema([]arrow.Field{
		{Name: "i32", Type: arrow.PrimitiveTypes.Int32, Nullable: true},
		{Name: "i64", Type: arrow.PrimitiveTypes.Int64, Nullable: true},
		{Name: "u16", Type: arrow.PrimitiveTypes.Uint16, Nullable: true},
		{Name: "f64", Type: arrow.PrimitiveTypes.Float64, Nullable: true},
		{Name: "flag", Type: arrow.FixedWidthTypes.Boolean, Nullable: true},
		{Name: "text", Type: arrow.BinaryTypes.String, Nullable: true},
		{Name: "day", Type: arrow.FixedWidthTypes.Date32, Nullable: true},
		{Name: "ts", Type: &arrow.TimestampType{Unit: arrow.Microsecond, TimeZone: "UTC"}, Nullable: true},
		{Name: "dec", Type: &arrow.Decimal128Type{Precision: 12, Scale: 3}, Nullable: true},
	}, nil)
	b := array.NewRecordBuilder(mem, schema)
	defer b.Release()
	for i := 0; i < n; i++ {
		app := func(k, every int, f func()) {
			if keep(i, every) {
				f()
			} else {
				b.Field(k).AppendNull()
			}
		}
		app(0, 10, func() { b.Field(0).(*array.Int32Builder).Append(int32(i*7919 - 1000000)) })
		app(1, 11, func() { b.Field(1).(*array.Int64Builder).Append(int64(i)*30000000001 - 7) })
		app(2, 12, func() { b.Field(2).(*array.Uint16Builder).Append(uint16(i * 211)) })
		app(3, 13, func() { b.Field(3).(*array.Float64Builder).Append(float64(i)/3 - 50) })
		app(4, 14, func() { b.Field(4).(*array.BooleanBuilder).Append(i%3 == 0) })
		app(5, 15, func() { b.Field(5).(*array.StringBuilder).Append(fmt.Sprintf("gopher %d ✓", i%23)) })
		app(6, 16, func() { b.Field(6).(*array.Date32Builder).Append(arrow.Date32(i*97 - 10000)) })
		app(7, 17, func() {
			b.Field(7).(*array.TimestampBuilder).Append(arrow.Timestamp(int64(i)*3601000007 + 1262304000000000))
		})
		app(8, 18, func() {
			b.Field(8).(*array.Decimal128Builder).Append(decimal128FromInt(int64(i*1999 - 250000)))
		})
	}
	rec := b.NewRecord()
	defer rec.Release()
	f, err := os.Create(filepath.Join(out, "arrow_go_default.parquet"))
	check(err)
	props := parquet.NewWriterProperties(parquet.WithCompression(compress.Codecs.Snappy), parquet.WithMaxRowGroupLength(128))
	w, err := pqarrow.NewFileWriter(schema, f, props, pqarrow.DefaultWriterProps())
	check(err)
	check(w.Write(rec))
	check(w.Close())
}

type row struct {
	ID    int64      `parquet:"id"`
	Score *float64   `parquet:"score,optional"`
	Name  *string    `parquet:"name,optional"`
	Seen  *time.Time `parquet:"seen,optional,timestamp(millisecond)"`
	Small int32      `parquet:"small"`
	Flag  *bool      `parquet:"flag,optional"`
	Data  []byte     `parquet:"data,optional"`
	Kind  string     `parquet:"kind,dict"`
}

func parquetGo(out string) {
	rows := make([]row, n)
	for i := range rows {
		r := row{ID: int64(i)*30000000001 - 7, Small: int32(i*101 - 15000), Kind: []string{"a", "b", "c"}[i%3]}
		if keep(i, 10) {
			v := float64(i) / 7
			r.Score = &v
		}
		if keep(i, 11) {
			v := fmt.Sprintf("parquet-go %d ü", i%29)
			r.Name = &v
		}
		if keep(i, 12) {
			v := time.UnixMilli(int64(i)*86461250 + 1262304000000).UTC()
			r.Seen = &v
		}
		if keep(i, 13) {
			v := i%2 == 0
			r.Flag = &v
		}
		if keep(i, 14) {
			r.Data = []byte{byte(i), 0, 255}
		}
		rows[i] = r
	}
	check(pgo.WriteFile(filepath.Join(out, "parquet_go_default.parquet"), rows))
}

func main() {
	out := os.Args[1]
	arrowGo(out)
	parquetGo(out)
}

func check(err error) {
	if err != nil {
		panic(err)
	}
}
