// Shared helpers for the desktop grid performance benchmark.
//
// Fixture generation is deterministic (same rows/cols/merges every run) so
// results are comparable across commits; measurement helpers poll observable
// grid state (the accessibility cells Glide mirrors onto the DOM) rather than
// waiting fixed delays, per the repo test rules.
import * as fs from 'fs';
import * as path from 'path';
import CFB from 'cfb';
import { expect } from '@playwright/test';
import type { Page } from '@playwright/test';

export const GRID_CANVAS = '[data-testid="data-grid-canvas"]';

/** Stream a deterministic CSV to disk without holding the whole file in memory. */
export function write_large_csv(file: string, rows: number, cols: number): void {
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

const col_letter = (col: number): string => {
    let name = '';
    let c = col;
    do {
        name = String.fromCharCode(65 + (c % 26)) + name;
        c = Math.floor(c / 26) - 1;
    } while (c >= 0);
    return name;
};

const a1 = (row: number, col: number): string => `${col_letter(col)}${row + 1}`;

export interface MergeSpec {
    startRow: number;
    startCol: number;
    endRow: number;
    endCol: number;
}

/**
 * The merge layout the benchmark exercises: a steady stream of vertical
 * merges (the overlay-canvas path today, the native path after the port),
 * plus horizontal and 2D blocks. Deterministic and dense enough that many
 * merges are always in the viewport while scrolling.
 */
export function benchmark_merges(rows: number, cols: number): MergeSpec[] {
    const merges: MergeSpec[] = [];
    // Column 0: vertical merges of height 5, back to back.
    for (let r = 0; r + 4 < rows; r += 5) {
        merges.push({ startRow: r, startCol: 0, endRow: r + 4, endCol: 0 });
    }
    // Every 10th row: a horizontal merge across columns 2-4.
    for (let r = 1; r < rows; r += 10) {
        merges.push({ startRow: r, startCol: 2, endRow: r, endCol: Math.min(4, cols - 1) });
    }
    // Every 25th row: a 3x2 block in columns 5-6.
    if (cols > 6) {
        for (let r = 2; r + 2 < rows; r += 25) {
            merges.push({ startRow: r, startCol: 5, endRow: r + 2, endCol: 6 });
        }
    }
    return merges;
}

/**
 * Build a single-sheet xlsx on disk with inline-string cells and the given
 * merges. Covered (non-anchor) cells are emitted empty, matching how real
 * spreadsheets store merged ranges.
 */
export function write_merged_xlsx(
    file: string,
    rows: number,
    cols: number,
    merges: MergeSpec[],
): void {
    const covered = new Set<string>();
    for (const m of merges) {
        for (let r = m.startRow; r <= m.endRow; r++) {
            for (let c = m.startCol; c <= m.endCol; c++) {
                if (r === m.startRow && c === m.startCol) continue;
                covered.add(`${r}:${c}`);
            }
        }
    }

    const parts: string[] = [];
    parts.push('<?xml version="1.0" encoding="UTF-8"?>\n');
    parts.push('<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">\n');
    parts.push(`<dimension ref="A1:${a1(rows - 1, cols - 1)}"/><sheetData>\n`);
    for (let r = 0; r < rows; r++) {
        const cells: string[] = [];
        for (let c = 0; c < cols; c++) {
            if (covered.has(`${r}:${c}`)) continue;
            cells.push(`<c r="${a1(r, c)}" t="inlineStr"><is><t>r${r}c${c}</t></is></c>`);
        }
        parts.push(`<row r="${r + 1}">${cells.join('')}</row>\n`);
    }
    parts.push('</sheetData>\n<mergeCells count="' + merges.length + '">');
    for (const m of merges) {
        parts.push(`<mergeCell ref="${a1(m.startRow, m.startCol)}:${a1(m.endRow, m.endCol)}"/>`);
    }
    parts.push('</mergeCells>\n</worksheet>');
    const sheet_xml = parts.join('');

    const content_types = `<?xml version="1.0" encoding="UTF-8"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="xml" ContentType="application/xml"/>
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
  <Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>
</Types>`;
    const rels = `<?xml version="1.0" encoding="UTF-8"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>
</Relationships>`;
    const workbook = `<?xml version="1.0" encoding="UTF-8"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <sheets><sheet name="Sheet1" sheetId="1" r:id="rId1"/></sheets>
</workbook>`;
    const workbook_rels = `<?xml version="1.0" encoding="UTF-8"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>
</Relationships>`;

    const cfb_file = CFB.utils.cfb_new();
    CFB.utils.cfb_add(cfb_file, '/[Content_Types].xml', Buffer.from(content_types));
    CFB.utils.cfb_add(cfb_file, '/_rels/.rels', Buffer.from(rels));
    CFB.utils.cfb_add(cfb_file, '/xl/workbook.xml', Buffer.from(workbook));
    CFB.utils.cfb_add(cfb_file, '/xl/_rels/workbook.xml.rels', Buffer.from(workbook_rels));
    CFB.utils.cfb_add(cfb_file, '/xl/worksheets/sheet1.xml', Buffer.from(sheet_xml));
    const out = CFB.write(cfb_file, { type: 'buffer', fileType: 'zip' }) as Buffer;
    fs.writeFileSync(file, out);
}

/** Wait until the grid has laid out (canvas visible + first data cell in the
 *  accessibility mirror), the observable "the file is open and rendered". */
export async function wait_for_grid(page: Page): Promise<void> {
    await page.locator(GRID_CANVAS).first().waitFor({ state: 'visible', timeout: 120_000 });
    await page.locator('#glide-cell-1-0').waitFor({ state: 'attached', timeout: 120_000 });
}

export interface ScrollMetrics {
    /** Per-frame deltas in ms across the measured scroll, concatenated over passes. */
    frame_ms: number[];
    /** Total wall-clock ms spent scrolling (all passes). */
    total_ms: number;
}

/**
 * Drive the grid's scroller down `steps` frames of `delta_px` each and record
 * the requestAnimationFrame cadence. The rAF loop is the measurement itself
 * (each await resolves on the next real frame), not a fixed-delay wait.
 */
export async function measure_scroll(
    page: Page,
    opts: { steps: number; delta_px: number; passes: number },
): Promise<ScrollMetrics> {
    const scroller = page.locator('.dvn-scroller').first();
    await scroller.waitFor({ state: 'attached' });

    const frame_ms: number[] = [];
    let total_ms = 0;
    for (let pass = 0; pass < opts.passes; pass++) {
        // Reset to the top and let the grid settle: poll until the first row's
        // accessibility cell is back (observable completion of the jump).
        await page.evaluate(() => {
            const el = document.querySelector('.dvn-scroller');
            if (el) el.scrollTop = 0;
        });
        await expect
            .poll(() => page.locator('#glide-cell-1-0').count(), { timeout: 30_000 })
            .toBeGreaterThan(0);

        const frames = await page.evaluate(
            async ({ steps, deltaPx }) => {
                const el = document.querySelector('.dvn-scroller');
                if (!el) throw new Error('no .dvn-scroller');
                const out: number[] = [];
                let last = performance.now();
                for (let i = 0; i < steps; i++) {
                    el.scrollTop += deltaPx;
                    await new Promise<number>((resolve) => requestAnimationFrame(resolve));
                    const now = performance.now();
                    out.push(now - last);
                    last = now;
                }
                return out;
            },
            { steps: opts.steps, deltaPx: opts.delta_px },
        );
        // Drop the first frame of each pass: it absorbs the settle after the
        // jump to the top and is not steady-state scrolling.
        frame_ms.push(...frames.slice(1));
        total_ms += frames.reduce((a, b) => a + b, 0);
    }
    return { frame_ms, total_ms };
}

export function percentile(sorted: number[], p: number): number {
    if (sorted.length === 0) return 0;
    const idx = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
    return sorted[Math.max(0, idx)];
}

export interface ScrollSummary {
    p50_ms: number;
    p95_ms: number;
    /** Frames slower than 2x the median frame — stutters, not load. */
    long_frames: number;
    frames: number;
    total_ms: number;
}

export function summarize_scroll(metrics: ScrollMetrics): ScrollSummary {
    const sorted = [...metrics.frame_ms].sort((a, b) => a - b);
    const p50 = percentile(sorted, 50);
    return {
        p50_ms: round2(p50),
        p95_ms: round2(percentile(sorted, 95)),
        long_frames: metrics.frame_ms.filter((f) => f > Math.max(2 * p50, 34)).length,
        frames: metrics.frame_ms.length,
        total_ms: round2(metrics.total_ms),
    };
}

const round2 = (n: number): number => Math.round(n * 100) / 100;

export interface BenchmarkResult {
    meta: {
        date: string;
        node: string;
        platform: string;
        arch: string;
        label: string;
    };
    scenarios: Record<string, Record<string, number>>;
}

/** Append/update one scenario in the shared results file for this run. */
export function record_scenario(
    results_file: string,
    label: string,
    scenario: string,
    values: Record<string, number>,
): void {
    let result: BenchmarkResult;
    try {
        result = JSON.parse(fs.readFileSync(results_file, 'utf8')) as BenchmarkResult;
    } catch {
        result = {
            meta: {
                date: new Date().toISOString(),
                node: process.version,
                platform: process.platform,
                arch: process.arch,
                label,
            },
            scenarios: {},
        };
    }
    result.scenarios[scenario] = values;
    fs.mkdirSync(path.dirname(results_file), { recursive: true });
    fs.writeFileSync(results_file, JSON.stringify(result, null, 2) + '\n');
}
