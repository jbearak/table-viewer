import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import {
    activate_extension,
    close_all_editors,
    has_webview_tab,
    wait_for,
} from './helpers';

/**
 * Perf smoke (host-observable half of the perf gate): a large CSV must open
 * through the demand-paged pipeline without exceeding the file-size guard,
 * being row-truncated, or blowing a generous wall-clock budget. The canvas
 * scroll smoothness at 1M rows remains a human check; this guards the host
 * read+parse+post path that feeds it.
 *
 * Row count defaults to 200k. Set TABLE_VIEWER_PERF_ROWS to override (e.g.
 * 1000000 for the full 1M-row check in CI or a local run).
 */
describe('large CSV perf smoke', function () {
    // Generation + read + parse + post needs more than the default per-test budget.
    this.timeout(120_000);

    const ROWS = Number(process.env.TABLE_VIEWER_PERF_ROWS ?? 200_000);
    const COLS = 8;
    let tmp_file: string;
    let original_max_rows: number | undefined;
    let original_max_size: number | undefined;

    before(async function () {
        this.timeout(120_000);
        await activate_extension();

        const config = vscode.workspace.getConfiguration('tableViewer');
        original_max_rows = config.get<number>('csvMaxRows');
        original_max_size = config.get<number>('maxFileSizeMiB');
        // Defaults (10k rows / 16 MiB) would truncate or reject a perf-sized file.
        await config.update('csvMaxRows', ROWS + 1, vscode.ConfigurationTarget.Global);
        await config.update('maxFileSizeMiB', 512, vscode.ConfigurationTarget.Global);

        tmp_file = path.join(os.tmpdir(), `table-viewer-perf-${ROWS}.csv`);
        write_large_csv(tmp_file, ROWS, COLS);
    });

    after(async () => {
        const config = vscode.workspace.getConfiguration('tableViewer');
        await config.update('csvMaxRows', original_max_rows, vscode.ConfigurationTarget.Global);
        await config.update('maxFileSizeMiB', original_max_size, vscode.ConfigurationTarget.Global);
        try {
            if (tmp_file) fs.unlinkSync(tmp_file);
        } catch {
            /* best-effort cleanup */
        }
    });

    afterEach(async () => {
        await close_all_editors();
        await wait_for(() => has_webview_tab('tableViewer.csvTable') === false, 5000);
    });

    it(`opens a ${ROWS.toLocaleString()}-row CSV within budget`, async () => {
        const started = Date.now();
        await vscode.commands.executeCommand(
            'tableViewer.openCsvTable',
            vscode.Uri.file(tmp_file),
        );
        const opened = await wait_for(
            () => has_webview_tab('tableViewer.csvTable'),
            60_000,
        );
        const elapsed = Date.now() - started;
        assert.ok(opened, `large CSV did not open a table tab (waited ${elapsed}ms)`);
        // Generous ceiling: this is a regression tripwire, not a microbenchmark.
        assert.ok(
            elapsed < 60_000,
            `opening ${ROWS} rows took ${elapsed}ms, over the 60s budget`,
        );
    });
});

/** Stream a deterministic CSV to disk without holding the whole file in memory. */
function write_large_csv(file: string, rows: number, cols: number): void {
    const fd = fs.openSync(file, 'w');
    try {
        const header = Array.from({ length: cols }, (_, c) => `col${c + 1}`).join(',');
        fs.writeSync(fd, header + '\n');
        const CHUNK = 5_000;
        let buf = '';
        for (let r = 0; r < rows; r++) {
            const cells: string[] = [];
            for (let c = 0; c < cols; c++) cells.push(`r${r}c${c}`);
            buf += cells.join(',') + '\n';
            if ((r + 1) % CHUNK === 0) {
                fs.writeSync(fd, buf);
                buf = '';
            }
        }
        if (buf) fs.writeSync(fd, buf);
    } finally {
        fs.closeSync(fd);
    }
}
