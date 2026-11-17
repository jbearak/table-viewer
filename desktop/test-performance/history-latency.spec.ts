// Latency of Undo, Redo, sorting, and typing, for docs/plans/window-queue.md
// ("The latency spec, from V1 on"). Run with `npm run test:desktop-perf --
// history-latency`; it needs `npm run desktop:prepackage` and, for the paired
// rows, a baseline build: set TABLE_VIEWER_BASELINE_DIST to a copy of another
// build's `dist` directory. Without it the paired rows are skipped.
//
// Paired comparisons use the same endpoint on both builds: the grid's
// accessibility table, which the baseline can be measured by. The rows about
// this build alone use its `performance.mark`s, which the page emits only
// when the spec sets its test flag. Every wait polls for what it waits for.
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { _electron as electron, expect, test } from '@playwright/test';
import type { ElectronApplication, Page } from '@playwright/test';
import {
    cell_point,
    choose,
    open_column_menu,
    open_row_menu,
    type_into_cell,
} from '../test-smoke/structure-helpers';

const repo_dir = path.resolve(__dirname, '..', '..');
const STAGE_MAIN = path.join(repo_dir, 'dist', 'desktop', 'main.js');
const BASELINE_DIST = process.env.TABLE_VIEWER_BASELINE_DIST;
const BASELINE_MAIN = BASELINE_DIST === undefined
    ? undefined
    : path.join(BASELINE_DIST, 'desktop', 'main.js');
const VIEWER_URL_PREFIX = 'tv-app://viewer';
const OUT = process.env.TABLE_VIEWER_LATENCY_OUT
    ?? path.join(repo_dir, 'test-results', 'history-latency.jsonl');

let root: string;
let app: ElectronApplication | undefined;

test.beforeEach(() => {
    root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'tv-history-latency-')));
});

test.afterEach(async () => {
    if (app) await quit(app);
    app = undefined;
    fs.rmSync(root, { recursive: true, force: true });
});

function record(entry: Record<string, unknown>): void {
    fs.mkdirSync(path.dirname(OUT), { recursive: true });
    fs.appendFileSync(OUT, `${JSON.stringify({ at: new Date().toISOString(), ...entry })}\n`);
}

async function quit(launched: ElectronApplication): Promise<void> {
    const handle = launched.process();
    await launched.evaluate(({ app: electron_app }) => electron_app.quit()).catch(() => {});
    await expect.poll(() => handle.exitCode !== null || handle.signalCode !== null, { timeout: 30_000 })
        .toBe(true);
    await launched.close().catch(() => {});
}

async function launch(main_js: string, file: string): Promise<Page> {
    expect(fs.existsSync(main_js), `${main_js} exists`).toBe(true);
    const user_data = fs.mkdtempSync(path.join(root, 'user-data-'));
    app = await electron.launch({
        args: [main_js, file],
        cwd: repo_dir,
        env: { ...process.env, TABLE_VIEWER_USER_DATA_DIR: user_data },
    });
    const pages = () => app!.windows().filter((page) => page.url().startsWith(VIEWER_URL_PREFIX));
    await expect.poll(() => pages().length, { timeout: 30_000 }).toBe(1);
    const page = pages()[0];
    await page.locator('[data-testid="data-grid-canvas"]').first().waitFor({ state: 'visible' });
    await page.evaluate(() => {
        (globalThis as unknown as Record<string, unknown>).__TABLE_VIEWER_PERF_MARKS__ = true;
    });
    return page;
}

async function relaunch(main_js: string, file: string): Promise<Page> {
    if (app) await quit(app);
    app = undefined;
    return launch(main_js, file);
}

// ---------------------------------------------------------------- fixtures

const BIG_ROWS = 1_000_000;
const big_cells = (i: number): [number, number, number] => [i, (i * 7919) % 1_000_003, (i * 104_729) % 999_983];

function write_big(file: string): void {
    const fd = fs.openSync(file, 'w');
    try {
        fs.writeSync(fd, 'Id,First,Second\n');
        let chunk = '';
        for (let i = 1; i <= BIG_ROWS; i += 1) {
            chunk += `${big_cells(i).join(',')}\n`;
            if (i % 50_000 === 0) { fs.writeSync(fd, chunk); chunk = ''; }
        }
        if (chunk !== '') fs.writeSync(fd, chunk);
    } finally {
        fs.closeSync(fd);
    }
}

/** The first row a sort of `column` puts first in the large table. */
function big_first_row(column: 1 | 2, direction: 'ascending' | 'descending'): string {
    let best = big_cells(1);
    for (let i = 2; i <= BIG_ROWS; i += 1) {
        const candidate = big_cells(i);
        const better = direction === 'ascending'
            ? candidate[column] < best[column]
            : candidate[column] > best[column];
        if (better) best = candidate;
    }
    return best.join('|');
}

function write_small(file: string): void {
    const lines = ['Name,Value,Notes'];
    for (let i = 0; i < 60; i += 1) lines.push(`row${i},${i},note${i}`);
    fs.writeFileSync(file, `${lines.join('\n')}\n`);
}

// ---------------------------------------------------------------- page helpers

/** Click a sort item; answers the click's time in the page. */
async function click_sort(page: Page, column: number, direction: 'ascending' | 'descending'): Promise<number> {
    const menu = await open_column_menu(page, column);
    const entry = menu.getByRole('menuitemcheckbox', { name: `Sort ${direction}` });
    await expect(entry).not.toHaveAttribute('aria-disabled', 'true');
    await page.evaluate(() => {
        document.addEventListener('click', (event) => {
            (globalThis as unknown as Record<string, unknown>).__last_click = event.timeStamp;
        }, { capture: true, once: true });
    });
    await entry.click();
    await expect(menu).toHaveCount(0);
    return page.evaluate(() => (globalThis as unknown as Record<string, unknown>).__last_click as number);
}

async function post_history(page: Page, command: 'undo' | 'redo'): Promise<number> {
    return page.evaluate((sent) => {
        const t = performance.now();
        window.postMessage({ type: 'editCommand', command: sent }, '*');
        return t;
    }, command);
}

interface Mark { name: string; startTime: number; detail?: Record<string, unknown> }

async function marks_after(page: Page, since: number): Promise<Mark[]> {
    return page.evaluate((after) => performance.getEntriesByType('mark')
        .filter((entry) => entry.startTime >= after && entry.name.startsWith('tv:'))
        .map((entry) => ({
            name: entry.name,
            startTime: entry.startTime,
            detail: (entry as PerformanceMark).detail as Record<string, unknown> | undefined,
        })), since);
}

async function wait_mark(page: Page, name: string, since: number): Promise<Mark> {
    let found: Mark | undefined;
    await expect.poll(async () => {
        found = (await marks_after(page, since)).find((mark) => mark.name === name);
        return found !== undefined;
    }, { timeout: 120_000 }).toBe(true);
    return found!;
}

/** The generation the grid last rendered, by its marks; 0 before any. */
async function rendered_generation(page: Page): Promise<number> {
    return page.evaluate(() => {
        const marks = performance.getEntriesByName('tv:view-generation-rendered');
        const detail = (marks.at(-1) as PerformanceMark | undefined)?.detail as { generation?: number } | undefined;
        return detail?.generation ?? 0;
    });
}

async function first_row(page: Page): Promise<string> {
    return page.evaluate(() => [...(document.querySelector('tbody tr')?.querySelectorAll('td') ?? [])]
        .map((cell) => cell.textContent ?? '').join('|'));
}

async function settled(page: Page): Promise<void> {
    await expect(page.locator('.toolbar-progress')).toHaveCount(0, { timeout: 120_000 });
}

const median = (values: readonly number[]) => {
    const sorted = [...values].sort((a, b) => a - b);
    return sorted[Math.floor(sorted.length / 2)];
};

// ---------------------------------------------------------------- paired rows

/** One edit committed and undone, timed from the Undo's post to the old text in the accessibility table. */
async function undo_cell_edit(page: Page, row: number, round: number): Promise<number> {
    const cell = page.locator(`#glide-cell-2-${row}`);
    const before = (await cell.textContent()) ?? '';
    await type_into_cell(page, 2, row, `v${round}`);
    await page.evaluate(({ id, want }) => {
        const w = globalThis as Record<string, unknown>;
        w.__undone = undefined;
        const observer = new MutationObserver(() => {
            if (document.getElementById(id)?.textContent === want) {
                observer.disconnect();
                w.__undone = performance.now();
            }
        });
        observer.observe(document.body, { subtree: true, childList: true, characterData: true });
    }, { id: `glide-cell-2-${row}`, want: before });
    const posted = await post_history(page, 'undo');
    await expect.poll(() => page.evaluate(() => (globalThis as unknown as Record<string, unknown>).__undone), { timeout: 30_000 })
        .not.toBeUndefined();
    return (await page.evaluate(() => (globalThis as unknown as Record<string, unknown>).__undone as number)) - posted;
}

/**
 * One-character keys in an open editor: for each, how many frames began from
 * the key to the frame after its input, so 1 is the next frame. Answers those
 * counts and how many keys reached the editor.
 */
async function type_keys(page: Page): Promise<{ frames: number[]; typed: number }> {
    await page.evaluate(() => {
        const w = globalThis as Record<string, unknown>;
        const frames: number[] = [];
        w.__frames = frames;
        w.__typed = 0;
        let frame = 0;
        const tick = () => { frame += 1; requestAnimationFrame(tick); };
        requestAnimationFrame(tick);
        document.addEventListener('keydown', (event) => {
            const target = event.target as HTMLElement;
            if (!target.classList?.contains('cell-editor-input')) return;
            if (event.key.length !== 1 || event.metaKey || event.ctrlKey || event.altKey) return;
            w.__typed = (w.__typed as number) + 1;
            const at = frame;
            target.addEventListener('input', () => {
                requestAnimationFrame(() => frames.push(frame - at));
            }, { once: true });
        }, { capture: true });
    });
    for (let i = 0; i < 8; i += 1) {
        const point = await cell_point(page, 2, i);
        await page.mouse.dblclick(point.x, point.y);
        await expect(page.locator('.cell-editor-input')).toBeVisible();
        for (const ch of `typed${i}xyz`) await page.keyboard.press(ch);
        await page.keyboard.press('Escape');
        await expect(page.locator('.cell-editor-input')).toHaveCount(0);
    }
    // Every key that reached the editor has shown, or the counts are short.
    await expect.poll(() => page.evaluate(() => {
        const w = globalThis as unknown as Record<string, unknown>;
        return (w.__frames as number[]).length === w.__typed;
    })).toBe(true);
    return page.evaluate(() => {
        const w = globalThis as unknown as Record<string, unknown>;
        return { frames: w.__frames as number[], typed: w.__typed as number };
    });
}

test('idle Undo of a cell edit and typing, against the baseline build', async () => {
    test.skip(BASELINE_MAIN === undefined, 'TABLE_VIEWER_BASELINE_DIST is not set');
    test.setTimeout(1_200_000);
    const file = path.join(root, 'small.csv');
    const builds = { stage: STAGE_MAIN, baseline: BASELINE_MAIN! };
    const undo: Record<keyof typeof builds, number[]> = { stage: [], baseline: [] };
    const typing: Record<keyof typeof builds, { frames: number[]; typed: number }> = {
        stage: { frames: [], typed: 0 },
        baseline: { frames: [], typed: 0 },
    };
    // Four blocks of ten rounds each, alternating builds, so drift falls on both.
    const orders: readonly (readonly ('stage' | 'baseline')[])[] = [['stage', 'baseline'], ['baseline', 'stage']];
    for (let block = 0; block < 4; block += 1) {
        for (const build of orders[block % 2]) {
            write_small(file);
            const page = await relaunch(builds[build], file);
            for (let round = 0; round < 10; round += 1) {
                undo[build].push(await undo_cell_edit(page, 1 + round, round));
            }
            if (block === 0) typing[build] = await type_keys(page);
        }
    }
    const paired = undo.stage.map((value, index) => value - undo.baseline[index]);
    // The frame after the input's frame: at most two frame starts after the key.
    const within_next_frame = (keys: { frames: readonly number[] }) => keys.frames.filter((frames) => frames <= 2).length;
    record({
        kind: 'paired',
        undo_stage_ms: undo.stage.map(Math.round),
        undo_baseline_ms: undo.baseline.map(Math.round),
        undo_paired_difference_median_ms: Math.round(median(paired) * 10) / 10,
        typing_stage_keys: typing.stage.typed,
        typing_baseline_keys: typing.baseline.typed,
        typing_stage_within_next_frame: within_next_frame(typing.stage),
        typing_baseline_within_next_frame: within_next_frame(typing.baseline),
    });
    expect(Math.abs(median(paired))).toBeLessThanOrEqual(10);
    // Both builds saw every key (8 editors, 9 keys each), and this one shows at least
    // 98 % as many by the next frame.
    expect(typing.stage.typed).toBe(72);
    expect(typing.baseline.typed).toBe(72);
    expect(within_next_frame(typing.stage))
        .toBeGreaterThanOrEqual(Math.ceil(within_next_frame(typing.baseline) * 0.98));
});

// ---------------------------------------------------------------- this build, by its marks

test('a 1M-row sort: Undo before it installs, and a second sort during the first', async () => {
    test.setTimeout(1_200_000);
    const file = path.join(root, 'big.csv');
    write_big(file);
    const page = await launch(STAGE_MAIN, file);
    const natural = '1|7919|104729';
    await expect.poll(() => first_row(page), { timeout: 120_000 }).toBe(natural);

    // Warm both sorted columns, so each timed run below computes warm.
    for (const column of [1, 2]) {
        await click_sort(page, column, 'ascending');
        await settled(page);
        const since = await post_history(page, 'undo');
        await wait_mark(page, 'tv:history-changed', since);
        await settled(page);
        await expect.poll(() => first_row(page), { timeout: 120_000 }).toBe(natural);
    }

    // Undo before the host installs, on a sheet with no installed rules.
    const undo_without: number[] = [];
    for (let round = 0; round < 3; round += 1) {
        const clicked = await click_sort(page, 1, 'ascending');
        await expect(page.locator('.toolbar-progress')).toBeVisible();
        const posted = await post_history(page, 'undo');
        const ended = await wait_mark(page, 'tv:view-action-ended', posted);
        const rendered = (await marks_after(page, clicked))
            .filter((mark) => mark.name === 'tv:view-generation-rendered' && mark.startTime <= ended.startTime);
        expect(rendered, 'no sorted generation rendered').toEqual([]);
        undo_without.push(ended.startTime - posted);
        await settled(page);
    }

    // Undo before the host installs, on a sheet with installed rules: a cancel
    // back to them skips the computation.
    await click_sort(page, 0, 'descending');
    await settled(page);
    const installed_first = await first_row(page);
    const undo_with: number[] = [];
    for (let round = 0; round < 3; round += 1) {
        const clicked = await click_sort(page, 1, 'ascending');
        await expect(page.locator('.toolbar-progress')).toBeVisible();
        const posted = await post_history(page, 'undo');
        const ended = await wait_mark(page, 'tv:view-action-ended', posted);
        const rendered = (await marks_after(page, clicked))
            .filter((mark) => mark.name === 'tv:view-generation-rendered' && mark.startTime <= ended.startTime);
        expect(rendered, 'no sorted generation rendered').toEqual([]);
        undo_with.push(ended.startTime - posted);
        await settled(page);
        expect(await first_row(page)).toBe(installed_first);
    }
    let since = await post_history(page, 'undo');
    await wait_mark(page, 'tv:history-changed', since);
    await settled(page);
    await expect.poll(() => first_row(page), { timeout: 120_000 }).toBe(natural);

    // A second sort during the first, against the same sort alone.
    const lone: number[] = [];
    const second: number[] = [];
    const sorted_desc = big_first_row(2, 'descending');
    for (let round = 0; round < 3; round += 1) {
        const lone_click = await click_sort(page, 2, 'descending');
        lone.push((await wait_mark(page, 'tv:view-action-ended', lone_click)).startTime - lone_click);
        await settled(page);
        await expect.poll(() => first_row(page), { timeout: 60_000 }).toBe(sorted_desc);
        since = await post_history(page, 'undo');
        await wait_mark(page, 'tv:history-changed', since);
        await settled(page);

        const before = await rendered_generation(page);
        const first_click = await click_sort(page, 1, 'ascending');
        await expect(page.locator('.toolbar-progress')).toBeVisible();
        const second_click = await click_sort(page, 2, 'descending');
        const ended = await wait_mark(page, 'tv:view-action-ended', second_click);
        // Wait for a render past the generation before, then look at every render
        // since the first click: the first sort never installed, so there is one,
        // and it is the next generation.
        await expect.poll(async () => (await rendered_generation(page)) > before, { timeout: 60_000 }).toBe(true);
        await settled(page);
        await expect.poll(() => first_row(page), { timeout: 60_000 }).toBe(sorted_desc);
        const rendered = (await marks_after(page, first_click))
            .filter((mark) => mark.name === 'tv:view-generation-rendered')
            .map((mark) => mark.detail?.generation);
        expect(rendered, 'only the second sort rendered').toEqual([before + 1]);
        second.push(ended.startTime - second_click);
        since = await post_history(page, 'undo');
        await wait_mark(page, 'tv:history-changed', since);
        await settled(page);
    }

    // Recorded only: a filter composed onto a sort still computing, from its
    // Apply to the end of the action.
    await click_sort(page, 1, 'ascending');
    await expect(page.locator('.toolbar-progress')).toBeVisible();
    await choose(await open_column_menu(page, 0), 'Filter…');
    const popover = page.locator('.filter-popover');
    await expect(popover).toBeVisible();
    await popover.locator('#filter-condition').selectOption('contains');
    await popover.getByLabel('Filter value').fill('7');
    const apply_at = await page.evaluate(() => performance.now());
    await popover.getByRole('button', { name: 'Apply' }).click();
    const late_filter = (await wait_mark(page, 'tv:view-action-ended', apply_at)).startTime - apply_at;
    await settled(page);
    since = await post_history(page, 'undo');
    await wait_mark(page, 'tv:history-changed', since);
    await settled(page);
    await expect.poll(() => first_row(page), { timeout: 120_000 }).toBe(natural);

    // Recorded only: Hide rows on the large table, to the host's settlement.
    const row_menu = await open_row_menu(page, 0);
    const hide_at = await page.evaluate(() => performance.now());
    await choose(row_menu, 'Hide row');
    const hide = (await wait_mark(page, 'tv:view-request-settled', hide_at)).startTime - hide_at;
    await settled(page);
    since = await post_history(page, 'undo');
    await wait_mark(page, 'tv:history-changed', since);
    await settled(page);
    await expect.poll(() => first_row(page), { timeout: 120_000 }).toBe(natural);

    // Not measured: a cancel after "Only changed rows" is toggled. The toggle is
    // only in a compare window, which this table does not open.

    // Recorded only: Undo of a sort the host has installed.
    await click_sort(page, 1, 'ascending');
    await settled(page);
    const undo_posted = await post_history(page, 'undo');
    // To the host's settlement of the replay's request: the view is back then.
    const undo_installed = (await wait_mark(page, 'tv:view-request-settled', undo_posted)).startTime - undo_posted;

    record({
        kind: 'big-sort',
        undo_before_install_without_rules_ms: undo_without.map(Math.round),
        undo_before_install_with_rules_ms: undo_with.map(Math.round),
        lone_sort_ms: lone.map(Math.round),
        second_sort_ms: second.map(Math.round),
        undo_after_install_ms: Math.round(undo_installed),
        filter_composed_late_ms: Math.round(late_filter),
        hide_rows_ms: Math.round(hide),
    });
    expect(median(undo_without)).toBeLessThanOrEqual(500);
    expect(median(undo_with)).toBeLessThanOrEqual(500);
    expect(median(second) - median(lone)).toBeLessThanOrEqual(100);
});
