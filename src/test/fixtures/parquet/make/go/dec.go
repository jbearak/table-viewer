package main

import "github.com/apache/arrow-go/v18/arrow/decimal128"

func decimal128FromInt(v int64) decimal128.Num { return decimal128.FromI64(v) }
