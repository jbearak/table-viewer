// Source-level timings for docs/plans/parquet-measurements.md. One file and
// one page-cache size per process, so peak RSS belongs to that run. Bundle
// with esbuild (--bundle --platform=node --packages=external) inside the
// repository, then:
//
//   node source-bench.js <file.parquet|file.dta> <page cache MiB> [pages] [sparse pages]
//
// prints one JSON line: open and first-window times, sequential and random
// 256-row page medians and 95th percentiles, a sparse page (256 random rows,
// as a sorted view reads them), the block size, and peak RSS.
import { performance } from 'node:perf_hooks';
import { FileDtaDataSource } from '../../src/data-source/file-dta-source';
import { FileParquetDataSource } from '../../src/data-source/file-parquet-source';
import type { DataSource } from '../../src/data-source/interface';

function quantile(sorted: readonly number[], q: number): number {
    return sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))];
}

function summary(times: number[]): { median: number; p95: number } {
    const sorted = [...times].sort((a, b) => a - b);
    return { median: round(quantile(sorted, 0.5)), p95: round(quantile(sorted, 0.95)) };
}

function round(ms: number): number {
    return Math.round(ms * 100) / 100;
}

async function main(): Promise<void> {
    const [file, cache_mib, pages_arg, sparse_arg] = process.argv.slice(2);
    const pages = Number(pages_arg ?? 200);
    const sparse_pages = Number(sparse_arg ?? 5);
    const parquet = file.endsWith('.parquet');
    const began = performance.now();
    const source: DataSource & { block_rows?: number } = parquet
        ? await FileParquetDataSource.open(file, { pageCacheBytes: Number(cache_mib) * 1024 * 1024 })
        : await FileDtaDataSource.open(file);
    const opened = performance.now();
    source.read_rows(0, 0, 256);
    const first_window = performance.now() - opened;
    const sheet = source.meta().sheets[0];
    const rows = sheet.rowCount;

    const sequential: number[] = [];
    for (let page = 1; page <= pages && (page + 1) * 256 <= rows; page++) {
        const start = performance.now();
        source.read_rows(0, page * 256, 256);
        sequential.push(performance.now() - start);
    }

    let seed = 99;
    const random = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
    const random_pages: number[] = [];
    for (let page = 0; page < pages; page++) {
        const start_row = Math.floor(random() * (rows - 256));
        const start = performance.now();
        source.read_rows(0, start_row, 256);
        random_pages.push(performance.now() - start);
    }

    const sparse: number[] = [];
    for (let page = 0; page < sparse_pages; page++) {
        const indices = Array.from({ length: 256 }, () => Math.floor(random() * rows));
        const start = performance.now();
        await source.read_rows_indexed_async!(0, indices, () => false);
        sparse.push(performance.now() - start);
    }

    source.close();
    console.log(JSON.stringify({
        file: file.split('/').pop(),
        rows,
        columns: sheet.columnCount,
        page_cache_mib: parquet ? Number(cache_mib) : null,
        block_rows: source.block_rows ?? null,
        open_ms: round(opened - began),
        first_window_ms: round(first_window),
        sequential: summary(sequential),
        random: summary(random_pages),
        sparse_256_random_rows: sparse.length > 0 ? summary(sparse) : null,
        // maxRSS is in kilobytes.
        peak_rss_mib: Math.round(process.resourceUsage().maxRSS / 1024),
    }));
}

void main();
