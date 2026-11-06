// The heap that every column chunk's footer statistics hold once `chunks` is
// first read (dta-parser parses them all at once). Writes a file of
// <columns> x <groups> chunks (one row per row group), then reports the
// footer size and the heap held. Run inside the repository:
//   node --expose-gc benchmarks/parquet/chunk-heap.mjs out.parquet 1000 1000
import { openParquetFile, writeParquetFile } from '@jbearak/dta-parser/node';
const [out, columns_arg, groups_arg] = process.argv.slice(2);
const columns = Number(columns_arg);
const groups = Number(groups_arg);
const began = performance.now();
writeParquetFile(out, {
    variables: Array.from({ length: columns }, (_, c) => ({
        name: `v${c}`, type: 'double', values: Float64Array.from({ length: groups }, (_, row) => row + c),
    })),
}, { rowGroupSize: 1 });
const written = performance.now();
const reader = openParquetFile(out);
const opened = performance.now();
globalThis.gc();
const before = process.memoryUsage().heapUsed;
let chunks = 0;
for (const variable of reader.variables) chunks += variable.chunks.length;
const parsed = performance.now();
globalThis.gc();
const after = process.memoryUsage().heapUsed;
console.log(JSON.stringify({
    columns, groups, chunks,
    footer_mib: +(reader.info.footerBytes / 2 ** 20).toFixed(1),
    write_s: +((written - began) / 1000).toFixed(1),
    open_ms: Math.round(opened - written),
    parse_chunks_ms: Math.round(parsed - opened),
    chunk_heap_mib: +((after - before) / 2 ** 20).toFixed(1),
}));
reader.close();
