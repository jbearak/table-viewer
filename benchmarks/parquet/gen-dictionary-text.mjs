// Writes a Parquet file whose text columns are dictionary-encoded, as other
// libraries write text by default: <rows> rows of <columns> columns, half
// text (20 distinct words each) and half doubles. Run inside the repository:
//   node benchmarks/parquet/gen-dictionary-text.mjs out.parquet 200000 100
import { writeParquetFile } from '@jbearak/dta-parser/node';
const [out, rows_arg, columns_arg] = process.argv.slice(2);
const rows = Number(rows_arg);
const columns = Number(columns_arg);
let seed = 12345;
const random = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
const words = Array.from({ length: 20 }, (_, k) => `category ${String.fromCharCode(97 + k)} ${'label '.repeat(k % 4)}`.trim());
const variables = [];
for (let c = 0; c < columns; c++) {
    if (c % 2 === 0) {
        variables.push({ name: `t${c}`, type: 'string', values: Array.from({ length: rows }, () => words[Math.floor(random() * words.length)]) });
    } else {
        const values = new Float64Array(rows);
        for (let i = 0; i < rows; i++) values[i] = random() * 1e6;
        variables.push({ name: `x${c}`, type: 'double', values });
    }
}
writeParquetFile(out, { variables });
