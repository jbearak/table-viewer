// Grid performance benchmark: launches the built desktop bundle against
// deterministic generated fixtures and records open-time and scroll frame
// metrics to a JSON results file. It asserts only sanity (the grid opened,
// frames were produced); regression judgement happens by comparing the
// results file against a recorded baseline (see benchmarks/grid/compare.mjs).
//
// Scenarios:
//   csv-200k        - merge-free 200k x 8 CSV (the "no regression" gate)
//   xlsx-merged-5k  - 5k x 8 xlsx with ~1.7k vertical/horizontal/2D merges
//                     (the "overlay vs native" comparison)
//
// Run: npm run test:desktop-perf
// Output: test-results/grid-perf.json (or TABLE_VIEWER_PERF_OUT)
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { test, expect, _electron as electron } from '@playwright/test';
import type { ElectronApplication } from '@playwright/test';
import {
    GRID_CANVAS,
    benchmark_merges,
    measure_scroll,
    record_scenario,
    summarize_scroll,
    wait_for_grid,
    write_large_csv,
    write_merged_xlsx,
} from './perf-helpers';

const repo_dir = path.resolve(__dirname, '..', '..');
const main_js = path.join(repo_dir, 'dist', 'desktop', 'main.js');
const results_file =
    process.env.TABLE_VIEWER_PERF_OUT ?? path.join(repo_dir, 'test-results', 'grid-perf.json');
const run_label = process.env.TABLE_VIEWER_PERF_LABEL ?? 'local';

const CSV_ROWS = Number(process.env.TABLE_VIEWER_PERF_ROWS ?? 200_000);
const CSV_COLS = 8;
const XLSX_ROWS = 5_000;
const XLSX_COLS = 8;

const SCROLL = { steps: 240, delta_px: 120, passes: 3 };

let fixtures_dir: string;
let csv_file: string;
let xlsx_file: string;

test.beforeAll(() => {
    expect(fs.existsSync(main_js), 'run npm run desktop:prepackage first').toBe(true);
    fixtures_dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tv-perf-'));
    csv_file = path.join(fixtures_dir, `perf-${CSV_ROWS}.csv`);
    xlsx_file = path.join(fixtures_dir, 'perf-merged.xlsx');
    write_large_csv(csv_file, CSV_ROWS, CSV_COLS);
    write_merged_xlsx(xlsx_file, XLSX_ROWS, XLSX_COLS, benchmark_merges(XLSX_ROWS, XLSX_COLS));
});

test.afterAll(() => {
    fs.rmSync(fixtures_dir, { recursive: true, force: true });
});

async function launch_with(
    file: string,
    user_data: string,
): Promise<ElectronApplication> {
    return electron.launch({
        args: [main_js, file],
        cwd: repo_dir,
        env: { ...process.env, TABLE_VIEWER_USER_DATA_DIR: user_data },
    });
}

async function run_scenario(name: string, file: string): Promise<void> {
    const user_data = fs.mkdtempSync(path.join(os.tmpdir(), 'tv-perf-data-'));
    let app: ElectronApplication | undefined;
    try {
        const launch_started = Date.now();
        app = await launch_with(file, user_data);
        const page = await app.firstWindow();
        await page.locator(GRID_CANVAS).first().waitFor({ state: 'visible', timeout: 120_000 });
        const canvas_visible_ms = Date.now() - launch_started;
        await wait_for_grid(page);
        const first_cell_ms = Date.now() - launch_started;

        const metrics = await measure_scroll(page, SCROLL);
        const scroll = summarize_scroll(metrics);
        expect(scroll.frames).toBeGreaterThan(SCROLL.passes * (SCROLL.steps - 1) - 5);

        record_scenario(results_file, run_label, name, {
            open_canvas_ms: canvas_visible_ms,
            open_first_cell_ms: first_cell_ms,
            scroll_p50_ms: scroll.p50_ms,
            scroll_p95_ms: scroll.p95_ms,
            scroll_long_frames: scroll.long_frames,
            scroll_total_ms: scroll.total_ms,
        });
    } finally {
        // Close and rm independently: a failed launch leaves no app, and a
        // failed close must not leak the temp profile dir.
        try {
            await app?.close();
        } finally {
            fs.rmSync(user_data, { recursive: true, force: true });
        }
    }
}

test('csv-200k: merge-free open + scroll', async () => {
    await run_scenario('csv-200k', csv_file);
});

test('xlsx-merged-5k: merged open + scroll', async () => {
    await run_scenario('xlsx-merged-5k', xlsx_file);
});
