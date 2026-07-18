import { describe, it, expect, vi } from 'vitest';
import { ViewerPanelCore } from '../panel-core';
import type { DataSource, RowWindow, RenderedCell, WorkbookMeta } from '../data-source/interface';

class StubSource implements DataSource {
    read_rows_calls = 0;
    truncationMessage?: string;
    constructor(public rowCount = 100) {}
    meta(): WorkbookMeta {
        return {
            hasFormatting: false,
            sheets: [{ name: 'Sheet1', rowCount: this.rowCount, columnCount: 2, merges: [], hasFormatting: false }],
        };
    }
    read_rows(_sheet: number, start: number, count: number): RowWindow {
        this.read_rows_calls++;
        const rows: (RenderedCell | null)[][] = [];
        const end = Math.min(start + count, this.rowCount);
        for (let r = start; r < end; r++) {
            rows.push([{ raw: String(r), formatted: String(r), bold: false, italic: false }, null]);
        }
        return { startRow: start, rows };
    }
    close(): void {}
}

function make_panel() {
    const posted: any[] = [];
    const postMessage = vi.fn((m: any) => { posted.push(m); return Promise.resolve(true); });
    return { panel: { webview: { postMessage } }, posted, postMessage };
}

const ENVELOPE = { state: {}, defaultTabOrientation: 'horizontal' as const };

describe('ViewerPanelCore', () => {
    it('send_meta posts sheetMeta with the workbook meta and current generation', async () => {
        const { panel, posted } = make_panel();
        const core = new ViewerPanelCore(panel, new StubSource());
        await core.send_meta(ENVELOPE);
        expect(posted[0].type).toBe('sheetMeta');
        expect(posted[0].meta.sheets[0].rowCount).toBe(100);
        expect(posted[0].generation).toBe(core.generation);
        expect(posted[0].defaultTabOrientation).toBe('horizontal');
    });

    it('send_meta surfaces the source truncationMessage by default', async () => {
        const { panel, posted } = make_panel();
        const src = new StubSource();
        src.truncationMessage = 'Showing 2 of 4 rows';
        const core = new ViewerPanelCore(panel, src);
        await core.send_meta(ENVELOPE);
        expect(posted[0].truncationMessage).toBe('Showing 2 of 4 rows');
    });

    it('answers requestRows with rowData carrying the same requestId and window', async () => {
        const { panel, posted } = make_panel();
        const core = new ViewerPanelCore(panel, new StubSource());
        await core.handle_message({ type: 'requestRows', sheetIndex: 0, startRow: 10, count: 5, requestId: 'r1', generation: core.generation });
        const rd = posted.find((m) => m.type === 'rowData');
        expect(rd).toBeDefined();
        expect(rd.requestId).toBe('r1');
        expect(rd.sheetIndex).toBe(0);
        expect(rd.startRow).toBe(10);
        expect(rd.rows.length).toBe(5);
        expect(rd.rows[0][0].raw).toBe('10');
        expect(rd.generation).toBe(core.generation);
    });

    it('drops a requestRows whose generation is stale (post-reload)', async () => {
        const { panel, posted } = make_panel();
        const src = new StubSource();
        const core = new ViewerPanelCore(panel, src);
        const stale_generation = core.generation;
        await core.send_meta_reload();
        await core.handle_message({ type: 'requestRows', sheetIndex: 0, startRow: 0, count: 5, requestId: 'old', generation: stale_generation });
        expect(posted.find((m) => m.type === 'rowData')).toBeUndefined();
        expect(src.read_rows_calls).toBe(0);
    });

    it('serves a repeated window from cache without a second read_rows', async () => {
        const { panel } = make_panel();
        const src = new StubSource();
        const core = new ViewerPanelCore(panel, src);
        const base = { type: 'requestRows' as const, sheetIndex: 0, startRow: 0, count: 5, generation: core.generation };
        await core.handle_message({ ...base, requestId: 'a' });
        await core.handle_message({ ...base, requestId: 'b' });
        expect(src.read_rows_calls).toBe(1);
    });

    it('send_meta_reload bumps generation, clears cache, and posts metaReload', async () => {
        const { panel, posted } = make_panel();
        const src = new StubSource();
        const core = new ViewerPanelCore(panel, src);
        // Prime the cache.
        await core.handle_message({ type: 'requestRows', sheetIndex: 0, startRow: 0, count: 5, requestId: 'a', generation: core.generation });
        expect(src.read_rows_calls).toBe(1);

        const g0 = core.generation;
        await core.send_meta_reload();
        expect(core.generation).toBe(g0 + 1);
        const last = posted[posted.length - 1];
        expect(last.type).toBe('metaReload');
        expect(last.generation).toBe(g0 + 1);

        // Same window, new generation: cache was cleared, so read_rows runs again.
        await core.handle_message({ type: 'requestRows', sheetIndex: 0, startRow: 0, count: 5, requestId: 'c', generation: core.generation });
        expect(src.read_rows_calls).toBe(2);
    });

    it('clamps a negative startRow to 0 before reading (boundary validation)', async () => {
        const { panel, posted } = make_panel();
        const core = new ViewerPanelCore(panel, new StubSource());
        await core.handle_message({ type: 'requestRows', sheetIndex: 0, startRow: -5, count: 3, requestId: 'n', generation: core.generation });
        const rd = posted.find((m) => m.type === 'rowData');
        expect(rd).toBeDefined();
        expect(rd.startRow).toBe(0);
    });

    it('evicts least-recently-used pages beyond the cap', async () => {
        const { panel } = make_panel();
        const src = new StubSource(1000);
        const core = new ViewerPanelCore(panel, src, { maxCachedPages: 2 });
        const g = core.generation;
        const req = (startRow: number) => core.handle_message({ type: 'requestRows', sheetIndex: 0, startRow, count: 5, requestId: `r${startRow}`, generation: g });
        await req(0);   // cache: [0]
        await req(5);   // cache: [0,5]
        await req(10);  // evict 0 -> cache: [5,10]
        expect(src.read_rows_calls).toBe(3);
        await req(0);   // 0 was evicted -> read again
        expect(src.read_rows_calls).toBe(4);
    });

    it('applies a transform atomically, bumps generation, and serves display order', async () => {
        const { panel, posted } = make_panel();
        const core = new ViewerPanelCore(panel, new StubSource(5));
        const old_generation = core.generation;

        await core.handle_message({
            type: 'setTransform',
            sheetIndex: 0,
            requestId: 'sort-1',
            generation: old_generation,
            state: {
                sort: [{ colIndex: 0, direction: 'desc' }],
                filters: [],
                schema: '["Sheet1",2,null]',
            },
        });

        const applied = posted.find((message) => message.type === 'transformApplied');
        expect(applied).toMatchObject({
            requestId: 'sort-1',
            rowCount: 5,
        });
        expect(core.generation).toBe(old_generation + 1);

        await core.handle_message({
            type: 'requestRows',
            sheetIndex: 0,
            startRow: 0,
            count: 3,
            requestId: 'page',
            generation: core.generation,
        });
        const page = posted.find((message) => message.type === 'rowData');
        expect(page.rows.map((row: RenderedCell[]) => row[0].raw))
            .toEqual(['4', '3', '2']);
    });

    it('rolls back a failed transform without bumping generation', async () => {
        const { panel, posted } = make_panel();
        const core = new ViewerPanelCore(panel, new StubSource(5));
        const generation = core.generation;

        await core.handle_message({
            type: 'setTransform',
            sheetIndex: 0,
            requestId: 'bad',
            generation,
            state: {
                sort: [{ colIndex: 99, direction: 'asc' }],
                filters: [],
                schema: '["Sheet1",2,null]',
            },
        });

        const applied = posted.find((message) => message.type === 'transformApplied');
        expect(applied.requestId).toBe('bad');
        expect(applied.error).toContain('column index 99 out of range');
        expect(applied.state).toEqual({ sort: [], filters: [] });
        expect(core.generation).toBe(generation);
    });

    it('rejects a stale transform request after the source generation changes', async () => {
        const { panel, posted } = make_panel();
        const core = new ViewerPanelCore(panel, new StubSource(5));
        const stale_generation = core.generation;
        await core.send_meta_reload();

        await core.handle_message({
            type: 'setTransform',
            sheetIndex: 0,
            requestId: 'stale',
            generation: stale_generation,
            state: {
                sort: [{ colIndex: 0, direction: 'asc' }],
                filters: [],
                schema: '["Sheet1",2,null]',
            },
        });

        const applied = posted.find((message) =>
            message.type === 'transformApplied');
        expect(applied.error).toContain('source changed');
        expect(applied.state).toEqual({ sort: [], filters: [] });
        expect(core.generation).toBe(stale_generation + 1);
    });
});
