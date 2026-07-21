import { describe, it, expect, vi } from 'vitest';
import { ViewerPanelCore, adopt_source_into_core } from '../panel-core';
import type { DataSource, RowWindow, RenderedCell, WorkbookMeta } from '../data-source/interface';
import type { WebviewMessage } from '../types';

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

class CloseAwareSource extends StubSource {
    closed = false;
    override read_rows(sheet: number, start: number, count: number): RowWindow {
        if (this.closed) throw new Error('read after close');
        return super.read_rows(sheet, start, count);
    }
    override close(): void {
        this.closed = true;
    }
}

class UnrelatedAbortErrorSource extends StubSource {
    override read_rows(): RowWindow {
        const error = new Error('source aborted unexpectedly');
        error.name = 'AbortError';
        throw error;
    }
}

class TrackingColumnSource implements DataSource {
    readonly column_reads: { sheet: number; start: number; columns: number[] }[] = [];
    on_read?: () => void;

    constructor(
        private readonly row_count = 5,
        private readonly sheet_count = 1,
        private readonly column_count = 3,
    ) {}

    meta(): WorkbookMeta {
        return {
            hasFormatting: false,
            sheets: Array.from({ length: this.sheet_count }, (_, sheet) => ({
                name: `Sheet${sheet + 1}`,
                rowCount: this.row_count,
                columnCount: this.column_count,
                merges: [],
                hasFormatting: false,
            })),
        };
    }

    read_rows(sheet: number, start: number, count: number): RowWindow {
        return this.read_columns(sheet, start, count, [
            ...Array(this.column_count).keys(),
        ]);
    }

    read_columns(
        sheet: number,
        start: number,
        count: number,
        columns: readonly number[],
    ): RowWindow {
        this.column_reads.push({ sheet, start, columns: [...columns] });
        this.on_read?.();
        const end = Math.min(start + count, this.row_count);
        return {
            startRow: start,
            rows: Array.from({ length: end - start }, (_, offset) => (
                columns.map((column) => {
                    const raw = String((sheet + 1) * 1_000 + column * 100 + start + offset);
                    return { raw, formatted: raw, bold: false, italic: false };
                })
            )),
        };
    }

    close(): void {}
}

function make_panel() {
    const posted: any[] = [];
    const postMessage = vi.fn((m: any) => { posted.push(m); return Promise.resolve(true); });
    return { panel: { webview: { postMessage } }, posted, postMessage };
}

function deferred<T = void>() {
    let resolve!: (value: T | PromiseLike<T>) => void;
    const promise = new Promise<T>((done) => { resolve = done; });
    return { promise, resolve };
}

describe('ViewerPanelCore', () => {
    it('starts at generation 1/sourceGeneration 1 without posting metadata', () => {
        const { panel, posted } = make_panel();
        const core = new ViewerPanelCore(panel, new StubSource());
        expect(core.generation).toBe(1);
        expect(core.source_generation).toBe(1);
        expect(posted).toHaveLength(0);
        expect('send_meta' in core).toBe(false);
        expect('send_meta_reload' in core).toBe(false);
        expect('send_meta_recovery' in core).toBe(false);
    });

    it('snapshot_material clones and freezes source metadata and diagnostics', () => {
        const { panel } = make_panel();
        const src = new StubSource(4);
        src.truncationMessage = 'Showing 4 rows';
        const core = new ViewerPanelCore(panel, src);

        const material = core.snapshot_material();
        src.rowCount = 9;
        src.truncationMessage = 'Changed later';

        expect(material).toEqual({
            core: {
                generation: 1,
                sourceGeneration: 1,
                meta: {
                    hasFormatting: false,
                    sheets: [expect.objectContaining({ rowCount: 4 })],
                },
            },
            diagnostics: { truncationMessage: 'Showing 4 rows' },
        });
        expect(Object.isFrozen(material)).toBe(true);
        expect(Object.isFrozen(material.core.meta)).toBe(true);
        expect(Object.isFrozen(material.core.meta.sheets)).toBe(true);
        expect(Object.isFrozen(material.core.meta.sheets[0])).toBe(true);
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
        core.adopt_source(new StubSource());
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

    it('computes histograms lazily, caches by source/sheet/column, and reuses across view generations', async () => {
        const { panel, posted } = make_panel();
        const src = new StubSource(5);
        const core = new ViewerPanelCore(panel, src);
        expect(src.read_rows_calls).toBe(0);

        await core.handle_message({
            type: 'requestFilterHistogram', sheetIndex: 0, columnIndex: 0,
            requestId: 'hist-1', generation: core.generation,
            sourceGeneration: core.source_generation,
        });
        expect(src.read_rows_calls).toBe(2);
        expect(posted.at(-1)).toMatchObject({
            type: 'filterHistogram', requestId: 'hist-1', sheetIndex: 0,
            columnIndex: 0, sourceGeneration: 1,
        });
        expect(posted.at(-1).bins.reduce(
            (total: number, bin: { count: number }) => total + bin.count,
            0,
        )).toBe(5);

        await core.handle_message({
            type: 'setTransform', sheetIndex: 0, requestId: 'sort',
            generation: core.generation, sourceGeneration: core.source_generation,
            intent: 'user', state: {
                sort: [{ colIndex: 0, direction: 'desc' }], filters: [],
                schema: '["Sheet1",2,null]',
            },
        });
        expect(src.read_rows_calls).toBe(3);
        await core.handle_message({
            type: 'requestFilterHistogram', sheetIndex: 0, columnIndex: 0,
            requestId: 'hist-2', generation: core.generation,
            sourceGeneration: core.source_generation,
        });
        expect(src.read_rows_calls).toBe(3);
        expect(posted.at(-1)).toMatchObject({
            type: 'filterHistogram', requestId: 'hist-2', generation: core.generation,
        });
    });

    it('invalidates histogram cache on source adoption', async () => {
        const { panel } = make_panel();
        const first = new StubSource(2);
        const second = new StubSource(3);
        const core = new ViewerPanelCore(panel, first);
        await core.handle_message({
            type: 'requestFilterHistogram', sheetIndex: 0, columnIndex: 0,
            requestId: 'first', generation: 1, sourceGeneration: 1,
        });
        core.adopt_source(second);
        await core.handle_message({
            type: 'requestFilterHistogram', sheetIndex: 0, columnIndex: 0,
            requestId: 'second', generation: 2, sourceGeneration: 2,
        });
        expect(first.read_rows_calls).toBe(2);
        expect(second.read_rows_calls).toBe(2);
    });

    it('finishes and caches a source-valid histogram across a concurrent view generation bump', async () => {
        const { panel, posted } = make_panel();
        const src = new StubSource(1_001);
        const core = new ViewerPanelCore(panel, src);
        const histogram = core.handle_message({
            type: 'requestFilterHistogram', sheetIndex: 0, columnIndex: 0,
            requestId: 'in-flight', generation: 1, sourceGeneration: 1,
        });
        await core.handle_message({
            type: 'setTransform', sheetIndex: 0, requestId: 'view-bump',
            generation: 1, sourceGeneration: 1, intent: 'user',
            state: { sort: [], filters: [] },
        });
        expect(core.generation).toBe(2);
        await histogram;
        expect(posted.find((message) => message.requestId === 'in-flight'))
            .toMatchObject({
                type: 'filterHistogram', generation: 1, sourceGeneration: 1,
            });
        const reads_after_compute = src.read_rows_calls;
        await core.handle_message({
            type: 'requestFilterHistogram', sheetIndex: 0, columnIndex: 0,
            requestId: 'reuse', generation: 2, sourceGeneration: 1,
        });
        expect(src.read_rows_calls).toBe(reads_after_compute);
        expect(posted.at(-1)).toMatchObject({
            type: 'filterHistogram', requestId: 'reuse', generation: 2,
        });
    });

    it('fences cancelled, source-stale, and receiver-stale histogram results', async () => {
        const scenarios = ['editor', 'source', 'receiver'] as const;
        for (const scenario of scenarios) {
            const { panel, posted } = make_panel();
            const core = new ViewerPanelCore(panel, new StubSource(1_001));
            const pending = core.handle_message({
                type: 'requestFilterHistogram', sheetIndex: 0, columnIndex: 0,
                requestId: scenario, generation: 1, sourceGeneration: 1,
            });
            if (scenario === 'editor') {
                await core.handle_message({ type: 'cancelFilterHistogram', requestId: scenario });
            } else if (scenario === 'source') {
                core.adopt_source(new StubSource());
            } else {
                core.begin_receiver_epoch(1);
            }
            await pending;
            expect(posted.some((message) => message.type === 'filterHistogram')).toBe(false);
        }
    });

    it('rejects histogram requests with stale generations or invalid coordinates', async () => {
        const { panel, posted } = make_panel();
        const src = new StubSource();
        const core = new ViewerPanelCore(panel, src);
        for (const request of [
            { requestId: 'generation', generation: 0, sourceGeneration: 1, sheetIndex: 0, columnIndex: 0 },
            { requestId: 'source', generation: 1, sourceGeneration: 0, sheetIndex: 0, columnIndex: 0 },
            { requestId: 'sheet', generation: 1, sourceGeneration: 1, sheetIndex: 8, columnIndex: 0 },
            { requestId: 'column', generation: 1, sourceGeneration: 1, sheetIndex: 0, columnIndex: 8 },
            { requestId: 'negative-sheet', generation: 1, sourceGeneration: 1, sheetIndex: -1, columnIndex: 0 },
            { requestId: 'fractional-sheet', generation: 1, sourceGeneration: 1, sheetIndex: 0.5, columnIndex: 0 },
            { requestId: 'string-sheet', generation: 1, sourceGeneration: 1, sheetIndex: '0', columnIndex: 0 },
        ]) {
            await core.handle_message({
                type: 'requestFilterHistogram',
                ...request,
            } as Extract<WebviewMessage, { type: 'requestFilterHistogram' }>);
        }
        expect(posted).toHaveLength(7);
        expect(posted.every((message) =>
            message.type === 'filterHistogram' && typeof message.error === 'string'))
            .toBe(true);
        expect(src.read_rows_calls).toBe(0);
    });

    it('echoes the request tuple when a delayed histogram request is view-stale', async () => {
        const { panel, posted } = make_panel();
        const core = new ViewerPanelCore(panel, new StubSource());
        await core.handle_message({
            type: 'setTransform', sheetIndex: 0, requestId: 'bump',
            generation: 1, sourceGeneration: 1, intent: 'user',
            state: { sort: [], filters: [] },
        });
        expect(core.generation).toBe(2);
        await core.handle_message({
            type: 'requestFilterHistogram', sheetIndex: 0, columnIndex: 0,
            requestId: 'delayed', generation: 1, sourceGeneration: 1,
        });
        expect(posted.at(-1)).toMatchObject({
            type: 'filterHistogram', requestId: 'delayed',
            generation: 1, sourceGeneration: 1,
            error: 'The view changed before this histogram request arrived.',
        });
    });

    it('physical replacement advances both generations and clears cache exactly once', async () => {
        const { panel } = make_panel();
        const previous = new StubSource();
        const next = new StubSource();
        const core = new ViewerPanelCore(panel, previous);
        await core.handle_message({
            type: 'requestRows', sheetIndex: 0, startRow: 0, count: 5,
            requestId: 'before', generation: core.generation,
        });

        const result = adopt_source_into_core(core, panel, previous, next);
        expect(result.type).toBe('adopted');
        expect(core.generation).toBe(2);
        expect(core.source_generation).toBe(2);
        expect(core.generation).toBe(2);
        expect(core.source_generation).toBe(2);

        await core.handle_message({
            type: 'requestRows', sheetIndex: 0, startRow: 0, count: 5,
            requestId: 'after', generation: core.generation,
        });
        expect(previous.read_rows_calls).toBe(1);
        expect(next.read_rows_calls).toBe(1);
    });

    it('invalidates source and view generations when the same mutable source is reused', async () => {
        const { panel } = make_panel();
        const src = new StubSource();
        const core = new ViewerPanelCore(panel, src);
        await core.handle_message({
            type: 'requestRows', sheetIndex: 0, startRow: 0, count: 5,
            requestId: 'before', generation: core.generation,
        });
        const view_generation = core.generation;
        const source_generation = core.source_generation;

        const adopted = adopt_source_into_core(core, panel, src, src);
        expect(adopted.type).toBe('adopted');

        expect(core.source_generation).toBe(source_generation + 1);
        expect(core.generation).toBe(view_generation + 1);
        await core.handle_message({
            type: 'requestRows', sheetIndex: 0, startRow: 0, count: 5,
            requestId: 'after', generation: core.generation,
        });
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
            sourceGeneration: core.source_generation,
            intent: 'user',
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

    it('reuses extracted columns across transform changes and reads only newly needed columns', async () => {
        const { panel } = make_panel();
        const source = new TrackingColumnSource();
        const core = new ViewerPanelCore(panel, source);
        const apply = (requestId: string, state: WebviewMessage & { type: 'setTransform' }) => (
            core.handle_message({
                ...state,
                requestId,
                generation: core.generation,
                sourceGeneration: core.source_generation,
            })
        );
        const base = {
            type: 'setTransform' as const,
            sheetIndex: 0,
            requestId: '',
            generation: 0,
            sourceGeneration: 0,
            intent: 'user' as const,
        };

        await apply('first', {
            ...base,
            state: {
                sort: [{ colIndex: 0, direction: 'asc' }], filters: [],
                schema: '["Sheet1",3,null]',
            },
        });
        await apply('direction', {
            ...base,
            state: {
                sort: [{ colIndex: 0, direction: 'desc' }], filters: [],
                schema: '["Sheet1",3,null]',
            },
        });
        await apply('new-column', {
            ...base,
            state: {
                sort: [{ colIndex: 0, direction: 'desc' }],
                filters: [{
                    id: 'filter-1',
                    colIndex: 1, operator: 'greaterThan', value: '0',
                    caseSensitive: false, enabled: true,
                }],
                schema: '["Sheet1",3,null]',
            },
        });

        expect(source.column_reads.map((read) => read.columns)).toEqual([[0], [1]]);
    });

    it('shares transform columns with reconciliation and invalidates them on adoption', async () => {
        const { panel } = make_panel();
        const first = new TrackingColumnSource();
        const second = new TrackingColumnSource();
        const core = new ViewerPanelCore(panel, first);
        const state = {
            sort: [{ colIndex: 0, direction: 'asc' as const }], filters: [],
            schema: '["Sheet1",3,null]',
        };

        const prepared = await core.prepare_transform_reconciliation([state], () => false);
        expect(prepared).toBeDefined();
        await core.handle_message({
            type: 'setTransform', sheetIndex: 0, requestId: 'reuse',
            generation: core.generation, sourceGeneration: core.source_generation,
            intent: 'user', state: {
                ...state,
                sort: [{ colIndex: 0, direction: 'desc' }],
            },
        });
        expect(first.column_reads).toHaveLength(1);

        core.adopt_source(second);
        await core.handle_message({
            type: 'setTransform', sheetIndex: 0, requestId: 'adopted',
            generation: core.generation, sourceGeneration: core.source_generation,
            intent: 'user', state,
        });
        expect(second.column_reads.map((read) => read.columns)).toEqual([[0]]);
    });

    it('bounds retained transform columns by total cells using LRU eviction', async () => {
        const { panel } = make_panel();
        const source = new TrackingColumnSource(3);
        const core = new ViewerPanelCore(panel, source, {
            maxCachedTransformCells: 6,
        });
        const apply = async (column: number, requestId: string) => {
            await core.handle_message({
                type: 'setTransform', sheetIndex: 0, requestId,
                generation: core.generation, sourceGeneration: core.source_generation,
                intent: 'user', state: {
                    sort: [{ colIndex: column, direction: 'asc' }], filters: [],
                    schema: '["Sheet1",3,null]',
                },
            });
        };

        await apply(0, 'zero');
        await apply(1, 'one');
        await apply(0, 'touch-zero');
        await apply(2, 'two');
        await apply(1, 'one-again');

        expect(source.column_reads.map((read) => read.columns)).toEqual([
            [0], [1], [2], [1],
        ]);
    });

    it('keys retained transform columns by sheet as well as column', async () => {
        const { panel } = make_panel();
        const source = new TrackingColumnSource(3, 2);
        const core = new ViewerPanelCore(panel, source);
        for (const sheetIndex of [0, 1, 0]) {
            await core.handle_message({
                type: 'setTransform', sheetIndex,
                requestId: `sheet-${sheetIndex}-${core.generation}`,
                generation: core.generation, sourceGeneration: core.source_generation,
                intent: 'user', state: {
                    sort: [{ colIndex: 0, direction: sheetIndex === 0 ? 'asc' : 'desc' }],
                    filters: [], schema: `["Sheet${sheetIndex + 1}",3,null]`,
                },
            });
        }
        expect(source.column_reads.map((read) => [read.sheet, read.columns])).toEqual([
            [0, [0]], [1, [0]],
        ]);
    });

    it('does not cache a partial scan canceled by receiver turnover', async () => {
        const { panel } = make_panel();
        const source = new TrackingColumnSource(300);
        const core = new ViewerPanelCore(panel, source);
        core.begin_receiver_epoch(1);
        source.on_read = () => {
            source.on_read = undefined;
            core.begin_receiver_epoch(2);
        };
        await core.handle_message({
            type: 'setTransform', sheetIndex: 0, requestId: 'cancelled',
            generation: core.generation, sourceGeneration: core.source_generation,
            intent: 'user', state: {
                sort: [{ colIndex: 0, direction: 'asc' }], filters: [],
                schema: '["Sheet1",3,null]',
            },
        });
        const reads_after_cancel = source.column_reads.length;
        await core.handle_message({
            type: 'setTransform', sheetIndex: 0, requestId: 'retry',
            generation: core.generation, sourceGeneration: core.source_generation,
            intent: 'user', state: {
                sort: [{ colIndex: 0, direction: 'desc' }], filters: [],
                schema: '["Sheet1",3,null]',
            },
        });

        expect(reads_after_cancel).toBe(1);
        expect(source.column_reads.length).toBe(4);
    });

    it('does not publish superseded partial columns and reuses the winning scan', async () => {
        const { panel } = make_panel();
        const source = new TrackingColumnSource(300);
        const core = new ViewerPanelCore(panel, source);
        let winning: Promise<void> | undefined;
        source.on_read = () => {
            source.on_read = undefined;
            winning = core.handle_message({
                type: 'setTransform', sheetIndex: 0, requestId: 'winning',
                generation: core.generation, sourceGeneration: core.source_generation,
                intent: 'user', state: {
                    sort: [{ colIndex: 0, direction: 'desc' }], filters: [],
                    schema: '["Sheet1",3,null]',
                },
            });
        };
        await core.handle_message({
            type: 'setTransform', sheetIndex: 0, requestId: 'superseded',
            generation: core.generation, sourceGeneration: core.source_generation,
            intent: 'user', state: {
                sort: [{ colIndex: 0, direction: 'asc' }], filters: [],
                schema: '["Sheet1",3,null]',
            },
        });
        await winning;
        const reads_after_winner = source.column_reads.length;
        await core.handle_message({
            type: 'setTransform', sheetIndex: 0, requestId: 'cached',
            generation: core.generation, sourceGeneration: core.source_generation,
            intent: 'user', state: {
                sort: [{ colIndex: 0, direction: 'asc' }], filters: [],
                schema: '["Sheet1",3,null]',
            },
        });

        expect(reads_after_winner).toBe(4);
        expect(source.column_reads).toHaveLength(reads_after_winner);
    });

    it('reuses columns for legacy DataSource fallbacks without read_columns', async () => {
        const { panel } = make_panel();
        const source = new StubSource(5);
        const core = new ViewerPanelCore(panel, source);
        for (const direction of ['asc', 'desc'] as const) {
            await core.handle_message({
                type: 'setTransform', sheetIndex: 0, requestId: direction,
                generation: core.generation, sourceGeneration: core.source_generation,
                intent: 'user', state: {
                    sort: [{ colIndex: 0, direction }], filters: [],
                    schema: '["Sheet1",2,null]',
                },
            });
        }
        expect(source.read_rows_calls).toBe(1);
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
            sourceGeneration: core.source_generation,
            intent: 'user',
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
        const stale_source_generation = core.source_generation;
        core.adopt_source(new StubSource(5));

        await core.handle_message({
            type: 'setTransform',
            sheetIndex: 0,
            requestId: 'stale',
            generation: stale_generation,
            sourceGeneration: stale_source_generation,
            intent: 'user',
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

    it('accepts Cancel in the transform commit/ack gap for the same source', async () => {
        const { panel, posted } = make_panel();
        const persist_started = deferred();
        const release_persist = deferred();
        const core = new ViewerPanelCore(panel, new StubSource(5), {
            onTransformCommit: async (message) => {
                if (message.requestId === 'restore') {
                    persist_started.resolve();
                    await release_persist.promise;
                }
            },
        });
        const source_generation = core.source_generation;
        const restore = core.handle_message({
            type: 'setTransform',
            sheetIndex: 0,
            requestId: 'restore',
            generation: core.generation,
            sourceGeneration: source_generation,
            intent: 'restore',
            state: {
                sort: [{ colIndex: 0, direction: 'desc' }],
                filters: [],
                schema: '["Sheet1",2,null]',
            },
        });
        await persist_started.promise;

        // The restore has computed but has not acknowledged/bumped the view
        // generation. Cancel carries that old view generation but the same
        // source identity and must remain authoritative.
        await core.handle_message({
            type: 'setTransform',
            sheetIndex: 0,
            requestId: 'cancel',
            generation: 1,
            sourceGeneration: source_generation,
            intent: 'cancel',
            state: {
                sort: [],
                filters: [],
                schema: '["Sheet1",2,null]',
            },
        });
        release_persist.resolve();
        await restore;

        expect(posted.filter((message) =>
            message.type === 'transformApplied').map((message) => message.requestId))
            .toEqual(['cancel']);
        expect(core.generation).toBe(2);
    });

    it('cancels work and suppresses messages after disposal', async () => {
        const { panel, posted } = make_panel();
        const persist_started = deferred();
        const release_persist = deferred();
        const core = new ViewerPanelCore(panel, new StubSource(5), {
            onTransformCommit: async () => {
                persist_started.resolve();
                await release_persist.promise;
            },
        });
        const work = core.handle_message({
            type: 'setTransform',
            sheetIndex: 0,
            requestId: 'late',
            generation: core.generation,
            sourceGeneration: core.source_generation,
            intent: 'user',
            state: {
                sort: [{ colIndex: 0, direction: 'asc' }],
                filters: [],
                schema: '["Sheet1",2,null]',
            },
        });
        await persist_started.promise;
        core.dispose();
        release_persist.resolve();
        await work;
        expect(posted.some((message) => message.type === 'transformApplied'))
            .toBe(false);
    });

    it('cancels receiver-owned transform compute synchronously on a new epoch', async () => {
        const { panel, posted } = make_panel();
        const core = new ViewerPanelCore(panel, new StubSource(5));
        core.begin_receiver_epoch(1);
        const work = core.handle_message({
            type: 'setTransform',
            sheetIndex: 0,
            requestId: 'old-receiver',
            generation: core.generation,
            sourceGeneration: core.source_generation,
            intent: 'user',
            state: {
                sort: [{ colIndex: 0, direction: 'desc' }],
                filters: [],
                schema: '["Sheet1",2,null]',
            },
        });

        // compute_transform has reached its first cooperative checkpoint.
        core.begin_receiver_epoch(2);
        await work;

        expect(core.generation).toBe(1);
        expect(core.has_transform_work).toBe(false);
        expect(posted.some((message) => message.type === 'transformApplied'))
            .toBe(false);
    });

    it('installs a committed transform after receiver turnover without delivering its terminal', async () => {
        const { panel, posted } = make_panel();
        const commit_started = deferred();
        const release_commit = deferred();
        const core = new ViewerPanelCore(panel, new StubSource(5), {
            onTransformCommit: async (message) => {
                if (message.requestId === 'old-receiver') {
                    commit_started.resolve();
                    await release_commit.promise;
                }
            },
        });
        core.begin_receiver_epoch(1);
        await core.handle_message({
            type: 'setTransform', sheetIndex: 0, requestId: 'installed',
            generation: core.generation, sourceGeneration: core.source_generation,
            intent: 'user',
            state: {
                sort: [{ colIndex: 0, direction: 'desc' }], filters: [],
                schema: '["Sheet1",2,null]',
            },
        });
        const installed_generation = core.generation;
        posted.length = 0;

        const old_work = core.handle_message({
            type: 'setTransform', sheetIndex: 0, requestId: 'old-receiver',
            generation: installed_generation, sourceGeneration: core.source_generation,
            intent: 'user',
            state: {
                sort: [{ colIndex: 0, direction: 'asc' }], filters: [],
                schema: '["Sheet1",2,null]',
            },
        });
        await commit_started.promise;
        core.begin_receiver_epoch(2);
        release_commit.resolve();
        await old_work;

        expect(core.generation).toBe(installed_generation + 1);
        expect(posted.some((message) => message.type === 'transformApplied'))
            .toBe(false);
        await core.handle_message({
            type: 'requestRows', sheetIndex: 0, startRow: 0, count: 2,
            requestId: 'committed', generation: installed_generation + 1,
        });
        const rows = posted.find((message) => message.type === 'rowData');
        expect(rows.rows.map((row: RenderedCell[]) => row[0].raw)).toEqual(['0', '1']);
    });

    it('does not let old receiver cleanup clear newer same-sheet work', async () => {
        const { panel } = make_panel();
        const a_started = deferred();
        const a_gate = deferred();
        const b_started = deferred();
        const b_gate = deferred();
        const core = new ViewerPanelCore(panel, new StubSource(5), {
            onTransformCommit: async (message) => {
                if (message.requestId === 'A') {
                    a_started.resolve();
                    await a_gate.promise;
                } else if (message.requestId === 'B') {
                    b_started.resolve();
                    await b_gate.promise;
                }
            },
        });
        core.begin_receiver_epoch(1);
        const request = (requestId: string, direction: 'asc' | 'desc') => ({
            type: 'setTransform' as const,
            sheetIndex: 0,
            requestId,
            generation: core.generation,
            sourceGeneration: core.source_generation,
            intent: 'user' as const,
            state: {
                sort: [{ colIndex: 0, direction }],
                filters: [],
                schema: '["Sheet1",2,null]',
            },
        });

        const a = core.handle_message(request('A', 'desc'));
        await a_started.promise;
        core.begin_receiver_epoch(2);
        const b = core.handle_message(request('B', 'asc'));
        await b_started.promise;

        a_gate.resolve();
        await a;
        expect(core.has_transform_work).toBe(true);

        b_gate.resolve();
        await b;
        expect(core.has_transform_work).toBe(true);
        expect(core.generation).toBe(2);
    });

    it('terminally acknowledges an unrelated AbortError from the source', async () => {
        const { panel, posted } = make_panel();
        const core = new ViewerPanelCore(panel, new UnrelatedAbortErrorSource(5));
        await core.handle_message({
            type: 'setTransform',
            sheetIndex: 0,
            requestId: 'source-abort',
            generation: core.generation,
            sourceGeneration: core.source_generation,
            intent: 'user',
            state: {
                sort: [{ colIndex: 0, direction: 'asc' }],
                filters: [],
                schema: '["Sheet1",2,null]',
            },
        });

        expect(posted).toContainEqual(expect.objectContaining({
            type: 'transformApplied',
            requestId: 'source-abort',
            error: 'source aborted unexpectedly',
        }));
        expect(core.has_transform_work).toBe(false);
    });

    it('prepares ready reconciliation without mutating the installed view', async () => {
        const { panel } = make_panel();
        const core = new ViewerPanelCore(panel, new StubSource(5));
        core.begin_receiver_epoch(1);
        const prepared = await core.prepare_transform_reconciliation([{
            sort: [{ colIndex: 0, direction: 'desc' }],
            filters: [],
            schema: '["Sheet1",2,null]',
        }], () => false);

        expect(prepared).toBeDefined();
        expect(core.generation).toBe(1);
        expect(core.has_active_transform).toBe(false);
        expect(core.commit_transform_reconciliation(prepared!)).toBe(true);
        expect(core.generation).toBe(2);
        expect(core.has_active_transform).toBe(true);
    });

    it('rejects a prepared reconciliation after source adoption', async () => {
        const { panel } = make_panel();
        const core = new ViewerPanelCore(panel, new StubSource(5));
        core.begin_receiver_epoch(1);
        const prepared = await core.prepare_transform_reconciliation([{
            sort: [{ colIndex: 0, direction: 'desc' }],
            filters: [],
            schema: '["Sheet1",2,null]',
        }], () => false);
        expect(prepared).toBeDefined();

        core.adopt_source(new StubSource(5));
        expect(core.commit_transform_reconciliation(prepared!)).toBe(false);
        expect(core.has_active_transform).toBe(false);
        expect(core.generation).toBe(2);
    });

    it('refuses source installation on a disposed core without closing either source', () => {
        const { panel } = make_panel();
        const previous = new CloseAwareSource();
        const next = new CloseAwareSource();
        const core = new ViewerPanelCore(panel, previous);
        core.dispose();
        const generation = core.generation;
        const source_generation = core.source_generation;

        const result = adopt_source_into_core(core, panel, previous, next);

        expect(result).toEqual({ type: 'refused' });
        expect(core.generation).toBe(generation);
        expect(core.source_generation).toBe(source_generation);
        expect(previous.closed).toBe(false);
        expect(next.closed).toBe(false);
    });

    it('confirms installation before a throwing old-source close', async () => {
        const { panel, posted } = make_panel();
        const previous = new CloseAwareSource();
        previous.close = () => { throw new Error('close failed'); };
        const next = new StubSource(5);
        const core = new ViewerPanelCore(panel, previous);
        let installed: ViewerPanelCore | undefined;

        expect(() => adopt_source_into_core(
            core,
            panel,
            previous,
            next,
            undefined,
            (accepted) => { installed = accepted; },
        )).toThrow('close failed');

        expect(installed).toBe(core);
        expect(core.generation).toBe(2);
        expect(core.source_generation).toBe(2);
        expect(core.snapshot_material().core.meta.sheets[0].rowCount).toBe(5);
        expect(posted).toHaveLength(0);
    });

    it('cancels source work before closing a replaced source', async () => {
        const { panel, posted } = make_panel();
        const previous = new CloseAwareSource(2_001);
        const core = new ViewerPanelCore(panel, previous);
        const work = core.handle_message({
            type: 'setTransform',
            sheetIndex: 0,
            requestId: 'old-source',
            generation: core.generation,
            sourceGeneration: core.source_generation,
            intent: 'user',
            state: {
                sort: [{ colIndex: 0, direction: 'desc' }],
                filters: [],
                schema: '["Sheet1",2,null]',
            },
        });
        while (previous.read_rows_calls === 0) {
            await new Promise<void>((resolve) => setImmediate(resolve));
        }
        expect(previous.read_rows_calls).toBe(1);
        previous.close = () => {
            expect(core.has_transform_work).toBe(false);
            expect(core.generation).toBe(2);
            expect(core.source_generation).toBe(2);
            previous.closed = true;
        };

        adopt_source_into_core(
            core,
            panel,
            previous,
            new StubSource(5),
        );
        await work;

        expect(previous.closed).toBe(true);
        expect(previous.read_rows_calls).toBe(1);
        expect(posted.some((message) =>
            message.type === 'transformApplied'
            && message.requestId === 'old-source')).toBe(false);
    });

    it('fast-paths Cancel when the complete rollback state is already installed', async () => {
        const { panel, posted } = make_panel();
        const source = new StubSource(5);
        const commits: string[] = [];
        const core = new ViewerPanelCore(panel, source, {
            onTransformCommit: async (message) => { commits.push(message.requestId); },
        });
        const state = {
            sort: [{ colIndex: 0, direction: 'desc' as const }],
            filters: [],
            schema: '["Sheet1",2,null]',
        };
        await core.handle_message({
            type: 'setTransform', sheetIndex: 0, requestId: 'install',
            generation: core.generation, sourceGeneration: core.source_generation,
            intent: 'user', state,
        });
        const generation = core.generation;
        const reads = source.read_rows_calls;
        posted.length = 0;
        await core.handle_message({
            type: 'setTransform', sheetIndex: 0, requestId: 'cancel-fast',
            generation, sourceGeneration: core.source_generation,
            intent: 'cancel', state,
        });
        expect(source.read_rows_calls).toBe(reads);
        expect(core.generation).toBe(generation);
        expect(commits).toContain('cancel-fast');
        expect(posted).toContainEqual(expect.objectContaining({
            type: 'transformApplied', requestId: 'cancel-fast', rowCount: 5,
            generation,
        }));
    });

});
