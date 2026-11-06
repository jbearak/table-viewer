// What a kept block's decoded columns hold, measured, against the bound the
// source counted for it (9 bytes a number, 16 bytes plus twice the length a
// text value, 160 bytes plus the length a binary value, plus the chunks'
// uncompressed bytes). Bundle with esbuild (--bundle --platform=node
// --packages=external) inside the repository, then:
//   node --expose-gc block-memory.js <file.parquet>
// With no file, writes and measures a plain-text and a binary file in memory.
import { writeParquet } from '@jbearak/dta-parser';
import { FileParquetDataSource } from '../../src/data-source/file-parquet-source';
import { ParquetDataSource, type ParquetReaderSource } from '../../src/data-source/parquet-source';

const gc = (globalThis as { gc?: () => void }).gc!;

function held(): number {
    gc();
    const usage = process.memoryUsage();
    return usage.heapUsed + usage.arrayBuffers;
}

/** Measured includes any growth of the wasm module's memory during the read. */
function measure(name: string, source: ParquetReaderSource): void {
    const before = held();
    source.read_rows(0, 0, 1);
    // The rendered one-row window is small; what remains is the block.
    const after = held();
    const block = (source as unknown as { block?: { bytes: number; count: number } }).block;
    console.log(JSON.stringify({
        file: name,
        block_rows: block?.count,
        counted_mib: +((block?.bytes ?? 0) / 2 ** 20).toFixed(1),
        measured_mib: +((after - before) / 2 ** 20).toFixed(1),
    }));
    source.close();
}

async function main(): Promise<void> {
    const file = process.argv[2];
    if (file) {
        measure(
            file.split('/').pop()!,
            await FileParquetDataSource.open(file),
        );
        return;
    }
    const rows = 2048;
    const text = writeParquet({
        variables: Array.from({ length: 16 }, (_, c) => ({
            name: `t${c}`, type: 'string',
            values: Array.from({ length: rows }, (_, row) => `distinct value ${row} of column ${c} `.repeat(4)),
        })),
    });
    measure(
        'plain text, 16 columns of 2,048 distinct 140-byte strings',
        await ParquetDataSource.create(text),
    );
    const binary = writeParquet({
        variables: Array.from({ length: 16 }, (_, c) => ({
            name: `b${c}`, type: 'binary',
            values: Array.from({ length: rows }, (_, row) => Uint8Array.from({ length: 16 }, (_, k) => (k < 2 ? row >> (8 * k) : row * 31 + k + c) & 0xff)),
        })),
    });
    measure(
        'binary, 16 columns of 2,048 distinct 16-byte values',
        await ParquetDataSource.create(binary),
    );
}

void main();
