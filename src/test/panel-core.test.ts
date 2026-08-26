import { describe, it, expect, vi } from 'vitest';
import {
    InvalidPersistedTransformError,
    TransformAdmissionLapsedError,
    ViewerPanelCore,
    adopt_source_into_core,
    transform_states_equal,
} from '../panel-core';
import {
    DEFERRED_FILTER_IDENTITY,
    type DataSource,
    type RenderedCell,
    type RowWindow,
    type WorkbookMeta,
} from '../data-source/interface';
import { MAX_ROW_HEIGHT_PX, MIN_ROW_HEIGHT_PX } from '../webview/row-heights';
import type {
    HostMessage,
    SheetTransformState,
    SheetViewRecord,
    WebviewMessage,
} from '../types';
import { FILTER_DISTINCT_VALUE_BYTE_LIMIT } from '../types';

class StubSource implements DataSource {
    read_rows_calls = 0;
    truncationMessage?: string;
    constructor(public rowCount = 100) {}
    meta(): WorkbookMeta {
        return {
            hasFormatting: false,
            sheets: [{ name: 'Sheet1', rowCount: this.rowCount, sourceRowCount: this.rowCount, columnCount: 2, merges: [], hasFormatting: false }],
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
        private readonly value_for: (
            sheet: number,
            column: number,
            row: number,
        ) => string = (sheet, column, row) => String(
            (sheet + 1) * 1_000 + column * 100 + row,
        ),
    ) {}

    meta(): WorkbookMeta {
        return {
            hasFormatting: false,
            sheets: Array.from({ length: this.sheet_count }, (_, sheet) => ({
                name: `Sheet${sheet + 1}`,
                rowCount: this.row_count,
                sourceRowCount: this.row_count,
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
                    const raw = this.value_for(sheet, column, start + offset);
                    return { raw, formatted: raw, bold: false, italic: false };
                })
            )),
        };
    }

    close(): void {}
}

class TrackingIdentityColumnSource extends TrackingColumnSource {
    override read_columns(
        sheet: number,
        start: number,
        count: number,
        columns: readonly number[],
    ): RowWindow {
        const window = super.read_columns(sheet, start, count, columns);
        return {
            ...window,
            rows: window.rows.map((row) => row.map((cell) => cell === null
                ? null
                : { ...cell, filterKey: `identity:${cell.raw}` })),
        };
    }
}

class TrackingDeferredIdentityColumnSource extends TrackingColumnSource {
    resolve_calls = 0;

    constructor(readonly identity: string) {
        super(
            2,
            1,
            3,
            (_sheet, column) => String.fromCharCode('a'.charCodeAt(0) + column),
        );
    }

    override read_columns(
        sheet: number,
        start: number,
        count: number,
        columns: readonly number[],
    ): RowWindow {
        const window = super.read_columns(sheet, start, count, columns);
        return {
            ...window,
            rows: window.rows.map((row) => row.map((cell, offset) => {
                if (cell === null || columns[offset] !== 0) return cell;
                const deferred = {
                    ...cell,
                    rawByteLength: FILTER_DISTINCT_VALUE_BYTE_LIMIT + 1,
                };
                Object.defineProperty(deferred, DEFERRED_FILTER_IDENTITY, {
                    value: {
                        cachedKey: () => undefined,
                        resolveKey: async () => {
                            this.resolve_calls += 1;
                            return this.identity;
                        },
                    },
                });
                return deferred;
            })),
        };
    }
}

class TrackingRawTypeColumnSource extends TrackingColumnSource {
    override read_columns(
        sheet: number,
        start: number,
        count: number,
        columns: readonly number[],
    ): RowWindow {
        const window = super.read_columns(sheet, start, count, columns);
        return {
            ...window,
            rows: window.rows.map((row, row_offset) => row.map((cell, offset) => {
                if (cell === null) return null;
                const column = columns[offset];
                const raw = column === 0 ? String(start + row_offset + 1) : '1';
                return {
                    ...cell,
                    raw,
                    formatted: raw,
                    rawType: column === 0 ? 'date' as const : 'boolean' as const,
                };
            })),
        };
    }
}

class TrackingHistogramSource extends TrackingColumnSource {
    metadata_requests = 0;

    column_filter_metadata(): undefined {
        this.metadata_requests += 1;
        return undefined;
    }
}

function make_panel() {
    const posted: any[] = [];
    const postMessage = vi.fn((m: any) => { posted.push(m); return Promise.resolve(true); });
    return { panel: { webview: { postMessage } }, posted, postMessage };
}

/** Every answer to a setTransform, whichever arm it arrived on. */
function transform_answers(posted: any[]): any[] {
    return posted.filter((message) => (
        message.type === 'transformInstalled' || message.type === 'transformRefused'
    ));
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

    it('compares, installs, and clones hidden row transform state', async () => {
        expect(transform_states_equal(
            { sort: [], filters: [] },
            { sort: [], filters: [], hiddenRows: [] },
        )).toBe(true);
        expect(transform_states_equal(
            { sort: [], filters: [], hiddenRows: [1] },
            { sort: [], filters: [], hiddenRows: [2] },
        )).toBe(false);

        const { panel } = make_panel();
        const core = new ViewerPanelCore(panel, new StubSource(4));
        const before = core.generation;
        await core.handle_message({
            type: 'setTransform',
            sheetIndex: 0,
            state: {
                sort: [],
                filters: [],
                hiddenRows: [1],
                schema: JSON.stringify(['Sheet1', 2, null]),
            },
            requestId: 'hide',
            generation: core.generation,
            sourceGeneration: core.source_generation,
            intent: 'user',
        });
        expect(core.generation).toBe(before + 1);
        const state = core.transform_state(0);
        expect(state.hiddenRows).toEqual([1]);
        state.hiddenRows!.push(2);
        expect(core.transform_state(0).hiddenRows).toEqual([1]);
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
                // Per sheet, and empty with no permutation installed and no dirty-map
                // provider wired — but present, because every delivery is built from
                // this and the webview reads it positionally.
                hiddenEditedCellKeys: [[]],
                // Also per sheet, but `undefined` rather than `{}` with no durable-height
                // provider wired: the projection says "this sheet has no custom heights",
                // which is what an unwired core and an unresized sheet both mean.
                rowHeightProjection: [undefined],
                // And per sheet again: the generation at which each sheet's mapping last
                // moved, which on a fresh core is the initial floor for every sheet.
                mappingGenerations: [1],
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

    it('passes the accepted receiver epoch only after a successful rowData post', async () => {
        const { panel, postMessage } = make_panel();
        const served = vi.fn();
        const core = new ViewerPanelCore(panel, new StubSource(), {
            onRowWindowServed: served,
        });
        core.begin_receiver_epoch(7);
        const request = {
            type: 'requestRows' as const,
            sheetIndex: 0,
            startRow: 0,
            count: 1,
            generation: core.generation,
        };

        await core.handle_message({ ...request, requestId: 'accepted' });
        expect(served).toHaveBeenCalledOnce();
        expect(served.mock.calls[0][1]).toEqual({ startRow: 0, sourceRows: [0] });
        expect(served.mock.calls[0][2]).toBe(7);

        postMessage.mockResolvedValueOnce(false);
        await core.handle_message({ ...request, requestId: 'not-posted' });
        expect(served).toHaveBeenCalledOnce();
    });

    it('suppresses the served callback when the receiver turns over during rowData', async () => {
        const row_post = deferred<boolean>();
        const postMessage = vi.fn(() => row_post.promise);
        const panel = { webview: { postMessage } };
        const served = vi.fn();
        const core = new ViewerPanelCore(panel, new StubSource(), {
            onRowWindowServed: served,
        });
        core.begin_receiver_epoch(11);

        const request = core.handle_message({
            type: 'requestRows',
            sheetIndex: 0,
            startRow: 0,
            count: 1,
            requestId: 'old-receiver',
            generation: core.generation,
        });
        await vi.waitFor(() => expect(postMessage).toHaveBeenCalledOnce());
        core.begin_receiver_epoch(12);
        row_post.resolve(true);
        await request;

        expect(served).not.toHaveBeenCalled();
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

    it('computes each row-window cache weight only once', async () => {
        let formatted_reads = 0;
        class WeightedSource extends StubSource {
            override read_rows(_sheet: number, start: number, count: number): RowWindow {
                this.read_rows_calls++;
                return {
                    startRow: start,
                    rows: Array.from({ length: count }, (_, offset) => {
                        const raw = String(start + offset);
                        return [{
                            raw,
                            get formatted() {
                                formatted_reads += 1;
                                return raw;
                            },
                            bold: false,
                            italic: false,
                        }];
                    }),
                };
            }
        }
        const { panel } = make_panel();
        const core = new ViewerPanelCore(panel, new WeightedSource(1000));
        const request = (startRow: number) => core.handle_message({
            type: 'requestRows' as const,
            sheetIndex: 0,
            startRow,
            count: 5,
            requestId: `weight-${startRow}`,
            generation: core.generation,
        });

        await request(0);
        expect(formatted_reads).toBe(5);
        await request(5);
        // Only the newly inserted page is measured; the first page is not
        // traversed again merely to recompute aggregate cache weight.
        expect(formatted_reads).toBe(10);
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
        expect(src.read_rows_calls).toBe(1);
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
        expect(src.read_rows_calls).toBe(1);
        await core.handle_message({
            type: 'requestFilterHistogram', sheetIndex: 0, columnIndex: 0,
            requestId: 'hist-2', generation: core.generation,
            sourceGeneration: core.source_generation,
        });
        expect(src.read_rows_calls).toBe(1);
        expect(posted.at(-1)).toMatchObject({
            type: 'filterHistogram', requestId: 'hist-2', generation: core.generation,
        });
    });

    it('reuses sorted source analysis for a later histogram', async () => {
        const { panel, posted } = make_panel();
        const source = new TrackingColumnSource(300);
        const core = new ViewerPanelCore(panel, source);

        await core.handle_message({
            type: 'setTransform', sheetIndex: 0, requestId: 'sort-first',
            generation: core.generation, sourceGeneration: core.source_generation,
            intent: 'user', state: {
                sort: [{ colIndex: 0, direction: 'desc' }], filters: [],
                schema: '["Sheet1",3,null]',
            },
        });
        const reads_after_sort = source.column_reads.length;
        await core.handle_message({
            type: 'requestFilterHistogram', sheetIndex: 0, columnIndex: 0,
            requestId: 'hist-after-sort', generation: core.generation,
            sourceGeneration: core.source_generation,
        });

        expect(reads_after_sort).toBe(3);
        expect(source.column_reads).toHaveLength(reads_after_sort);
        expect(posted.at(-1)).toMatchObject({
            type: 'filterHistogram', requestId: 'hist-after-sort',
            columnKind: 'numeric',
        });
    });

    it('preserves raw-type classification when histograms hit transform analyses', async () => {
        const { panel, posted } = make_panel();
        const source = new TrackingRawTypeColumnSource(2, 1, 2);
        const core = new ViewerPanelCore(panel, source);

        for (const column of [0, 1]) {
            await core.handle_message({
                type: 'setTransform', sheetIndex: 0, requestId: `sort-${column}`,
                generation: core.generation,
                sourceGeneration: core.source_generation,
                intent: 'user', state: {
                    sort: [{ colIndex: column, direction: 'asc' }], filters: [],
                    schema: '["Sheet1",2,null]',
                },
            });
        }
        const reads_after_sorts = source.column_reads.length;
        for (const column of [0, 1]) {
            await core.handle_message({
                type: 'requestFilterHistogram', sheetIndex: 0,
                columnIndex: column, requestId: `typed-${column}`,
                generation: core.generation,
                sourceGeneration: core.source_generation,
            });
        }

        expect(source.column_reads).toHaveLength(reads_after_sorts);
        expect(posted.find((message) => message.requestId === 'typed-0'))
            .toMatchObject({ columnKind: 'orderedText', bins: [] });
        expect(posted.find((message) => message.requestId === 'typed-1'))
            .toMatchObject({ columnKind: 'text', bins: [] });
    });

    it('charges retained string allocations to histogram-result admission', async () => {
        const { panel } = make_panel();
        const source = new TrackingHistogramSource(
            10,
            1,
            1,
            (_sheet, _column, row) => String.fromCharCode('a'.charCodeAt(0) + row),
        );
        const core = new ViewerPanelCore(panel, source, {
            maxCachedHistogramBytes: 1_200,
        });
        const request = async (requestId: string) => {
            await core.handle_message({
                type: 'requestFilterHistogram', sheetIndex: 0, columnIndex: 0,
                requestId, generation: core.generation,
                sourceGeneration: core.source_generation,
            });
        };

        await request('first');
        await request('second');

        expect(source.metadata_requests).toBe(2);
        expect(source.column_reads.map((read) => read.columns)).toEqual([[0]]);
    });

    it('evicts completed histograms without discarding shared source analyses', async () => {
        const { panel } = make_panel();
        const source = new TrackingHistogramSource(
            2,
            1,
            2,
            (_sheet, column) => String(column + 1),
        );
        const core = new ViewerPanelCore(panel, source, {
            maxCachedHistogramBytes: 450,
        });
        const histogram = async (columnIndex: number, requestId: string) => {
            await core.handle_message({
                type: 'requestFilterHistogram', sheetIndex: 0, columnIndex,
                requestId, generation: core.generation,
                sourceGeneration: core.source_generation,
            });
        };

        await histogram(0, 'zero');
        await histogram(0, 'zero-cached');
        expect(source.metadata_requests).toBe(1);
        await histogram(1, 'one');
        await histogram(0, 'zero-recomputed');

        expect(source.metadata_requests).toBe(3);
        expect(source.column_reads.map((read) => read.columns)).toEqual([[0], [1]]);
    });

    it('does not retain a histogram analysis cancelled during acquisition', async () => {
        const { panel, posted } = make_panel();
        const source = new TrackingColumnSource(300);
        const core = new ViewerPanelCore(panel, source);
        source.on_read = () => {
            source.on_read = undefined;
            void core.handle_message({
                type: 'cancelFilterHistogram', requestId: 'cancelled',
            });
        };

        await core.handle_message({
            type: 'requestFilterHistogram', sheetIndex: 0, columnIndex: 0,
            requestId: 'cancelled', generation: core.generation,
            sourceGeneration: core.source_generation,
        });
        const reads_after_cancel = source.column_reads.length;
        await core.handle_message({
            type: 'requestFilterHistogram', sheetIndex: 0, columnIndex: 0,
            requestId: 'retry', generation: core.generation,
            sourceGeneration: core.source_generation,
        });

        expect(reads_after_cancel).toBe(1);
        expect(source.column_reads).toHaveLength(4);
        expect(posted.some((message) => message.requestId === 'cancelled')).toBe(false);
        expect(posted.at(-1)).toMatchObject({
            type: 'filterHistogram', requestId: 'retry',
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
        expect(first.read_rows_calls).toBe(1);
        expect(second.read_rows_calls).toBe(1);
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

        const applied = posted.find((message) => message.type === 'transformInstalled');
        expect(applied).toMatchObject({
            requestId: 'sort-1',
            view: {
                rowCount: 5,
                permuted: true,
                // The basis is what a stored record will later be checked against, so
                // its schema has to be this sheet's fingerprint — the same string
                // SheetTransformState.schema is matched on.
                basis: {
                    generation: old_generation + 1,
                    sourceGeneration: core.source_generation,
                    schema: '["Sheet1",2,null]',
                },
            },
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

    it('reports a permutation for every shape of active rule and none for an inactive one', async () => {
        // `permuted` is the webview's only answer to "are the rows on screen the source
        // rows", and it decides whether the display-keyed row-height affordances are
        // suppressed. It has to follow *activity*, not the presence of rules: hiding
        // rows and filtering permute without sorting anything, and a filter switched
        // off leaves rules the host still holds over rows it has not touched.
        const { panel, posted } = make_panel();
        const core = new ViewerPanelCore(panel, new StubSource(5));
        const install = async (requestId: string, state: SheetTransformState) => {
            await core.handle_message({
                type: 'setTransform',
                sheetIndex: 0,
                requestId,
                generation: core.generation,
                sourceGeneration: core.source_generation,
                intent: 'user',
                state,
            });
            const message = posted.filter(
                (candidate) => candidate.type === 'transformInstalled',
            ).at(-1);
            expect(message.requestId).toBe(requestId);
            return message as Extract<HostMessage, { type: 'transformInstalled' }>;
        };

        const hidden = (await install('hidden', {
            sort: [],
            filters: [],
            hiddenRows: [1, 3],
            schema: '["Sheet1",2,null]',
        })).view;
        expect(hidden.permuted).toBe(true);
        expect(hidden.rowCount).toBe(3);
        // The permuted arm's rules are the set the permutation was built from, and this
        // is the only place the *record's* copy is checked at all: emptying it failed a
        // single test elsewhere in the suite, because every webview test fabricates its
        // own record. Cancel's rollback baseline reads exactly this.
        if (!hidden.permuted) throw new Error('expected a permuted view');
        expect(hidden.rules.hiddenRows).toEqual([1, 3]);

        const disabled = await install('disabled', {
            sort: [],
            filters: [{
                id: 'filter-1',
                colIndex: 0,
                operator: 'contains',
                value: '1',
                caseSensitive: false,
                enabled: false,
            }],
            schema: '["Sheet1",2,null]',
        });
        expect(disabled.view.permuted).toBe(false);
        expect(disabled.view.rowCount).toBe(5);
        // The definition survives — on the message, which is where the host's durable
        // rules live now that the record carries rules only for a view it permuted.
        expect(disabled.rules?.filters).toHaveLength(1);

        // Probing for holes found this one: the ack normalizes a rule set with no
        // entries to `undefined`, and nothing held that to account — the assertion that
        // looked like it did reaches the path with no state stored at all. The webview
        // copies these rules straight into durable state, so an entry-less object here
        // is persisted where "no transform" belongs.
        const cleared = await install('cleared', {
            sort: [],
            filters: [],
            schema: '["Sheet1",2,null]',
        });
        expect(cleared.view.permuted).toBe(false);
        expect(cleared.rules).toBeUndefined();
    });

    describe('hiddenEditedCellKeys', () => {
        // StubSource's column 0 is the row index as text, so `equals '2'` keeps
        // exactly source row 2 and drops the other four.
        const keeps_only_row_2 = (id = 'filter-1'): SheetTransformState => ({
            sort: [],
            filters: [{
                id,
                colIndex: 0,
                operator: 'equals',
                value: '2',
                caseSensitive: false,
                enabled: true,
            }],
            schema: '["Sheet1",2,null]',
        });

        function counting_core(keys: readonly string[]) {
            const { panel, posted } = make_panel();
            const durablePendingEditKeys = vi.fn(() => keys);
            const core = new ViewerPanelCore(panel, new StubSource(5), {
                durablePendingEditKeys,
            });
            const install = async (
                requestId: string,
                state: SheetTransformState,
                intent: 'user' | 'restore' | 'cancel' = 'user',
            ) => {
                await core.handle_message({
                    type: 'setTransform',
                    sheetIndex: 0,
                    requestId,
                    generation: core.generation,
                    sourceGeneration: core.source_generation,
                    intent,
                    state,
                });
                const message = posted.filter(
                    (candidate) => candidate.type === 'transformInstalled',
                ).at(-1);
                expect(message.requestId).toBe(requestId);
                // Every rule set installed in here is active, so the ack is the
                // permuted arm — the only arm with hidden keys to report. Narrowed by
                // the discriminant rather than cast: if one of these stopped permuting,
                // the assertion below would say so instead of the field vanishing.
                const view = message.view as SheetViewRecord;
                if (!view.permuted) throw new Error('expected a permuted view');
                return view;
            };
            return { core, install, durablePendingEditKeys };
        }

        it('names the cells a filter excludes and not one in a surviving row', async () => {
            const { install } = counting_core(['0:0', '0:1', '2:0', '4:0']);

            const view = await install('filter', keeps_only_row_2());

            expect(view.rowCount).toBe(1);
            // Row 2 survives, so its edit is visible and unnamed; rows 0 and 4 do
            // not, and row 0 contributes both of its cells.
            expect([...view.hiddenEditedCellKeys].sort())
                .toEqual(['0:0', '0:1', '4:0']);
        });

        it('counts several cells in one hidden row as several cells', async () => {
            // In cells, not rows: three pieces of unsaved work are out of sight, and
            // saying "1" would understate what the user is holding. The conflict
            // banner counts *rows* for removed rows because there the cell no longer
            // exists; here it does.
            const { install } = counting_core(['0:0', '0:1', '4:0']);

            expect([...(await install('filter', keeps_only_row_2()))
                .hiddenEditedCellKeys].sort())
                .toEqual(['0:0', '0:1', '4:0']);
        });

        it('counts the cells explicitly hidden rows exclude', async () => {
            // The other exclusion mechanism, and the one that reads no column at all,
            // so nothing about the *columns* edited can be standing in for this.
            const { install } = counting_core(['1:0', '3:0', '3:1', '0:0']);

            const view = await install('hidden', {
                sort: [],
                filters: [],
                hiddenRows: [1, 3],
                schema: '["Sheet1",2,null]',
            });

            expect(view.rowCount).toBe(3);
            expect([...view.hiddenEditedCellKeys].sort())
                .toEqual(['1:0', '3:0', '3:1']);
        });

        const sort_only = (): SheetTransformState => ({
            sort: [{ colIndex: 0, direction: 'desc' }],
            filters: [],
            schema: '["Sheet1",2,null]',
        });

        const matches_every_row = (): SheetTransformState => ({
            sort: [],
            filters: [{
                id: 'filter-wide',
                colIndex: 0,
                operator: 'isNotEmpty',
                caseSensitive: false,
                enabled: true,
            }],
            schema: '["Sheet1",2,null]',
        });

        it('reports none for a sort, whose rows are all still there', async () => {
            // A sort permutes without dropping, so every row it was given is somewhere
            // in the view.
            const { install } = counting_core(['0:0', '4:0']);

            const view = await install('sort', sort_only());

            expect(view.permuted).toBe(true);
            expect(view.hiddenEditedCellKeys).toEqual([]);
        });

        it('reports none for a filter that excluded nothing', async () => {
            const { install } = counting_core(['0:0']);

            const view = await install('wide', matches_every_row());

            expect(view.rowCount).toBe(5);
            expect(view.hiddenEditedCellKeys).toEqual([]);
        });

        it('names a vanished row under a filter that excluded nothing', async () => {
            // The all-rows-match case, which used to return before inspecting a single
            // key. An enabled filter can match every row the file still has while an
            // edited row an external shrink removed is genuinely absent from the view —
            // and if that edit is in a column no rule reads, nothing else raises the
            // notice, so the user is never told the work is out of sight. StubSource(5)
            // has no row 9, which is what the shrink leaves behind.
            const { install } = counting_core(['9:0', '2:0']);

            const view = await install('wide', matches_every_row());

            expect(view.rowCount).toBe(5);
            expect(view.hiddenEditedCellKeys).toEqual(['9:0']);
        });

        it('names a vanished row under a bare sort', async () => {
            // Same defect behind the other short-circuit: "no rule excludes rows" was
            // read as "no row can be missing", and a sort is exactly the view where the
            // permutation drops nothing and the *source* has still lost the row.
            const { install } = counting_core(['9:0', '2:0']);

            const view = await install('sort', sort_only());

            expect(view.hiddenEditedCellKeys).toEqual(['9:0']);
        });

        it('reports none when the session holds no pending edits', async () => {
            const { install } = counting_core([]);

            expect((await install('filter', keeps_only_row_2())).hiddenEditedCellKeys)
                .toEqual([]);
        });

        it('carries the count on both no-op equal-state acks', async () => {
            // These two short-circuit before any compute, so they could easily answer
            // with a default. They are `transformInstalled` messages describing the
            // view in place, and that view hides the same cells.
            const { install } = counting_core(['0:0', '0:1', '2:0', '4:0']);
            const installed = keeps_only_row_2();
            const hidden = ['0:0', '0:1', '4:0'];
            expect([...(await install('user', installed)).hiddenEditedCellKeys].sort())
                .toEqual(hidden);

            expect([...(await install('restore', installed, 'restore'))
                .hiddenEditedCellKeys].sort()).toEqual(hidden);
            expect([...(await install('cancel', installed, 'cancel'))
                .hiddenEditedCellKeys].sort()).toEqual(hidden);
        });

        it('counts an edit whose row the source no longer has', async () => {
            // Reachable after an external shrink: adopt_source drops the permutation,
            // then the restore recomputes it over fewer rows while the durable edits
            // still name the old ones. Counted deliberately — the row is certainly not
            // in the view, and the user is certainly holding work they cannot see,
            // which is why the copy says the view does not *show* the row rather than
            // that it hides it.
            const { install } = counting_core(['9:0', '2:0']);

            expect((await install('filter', keeps_only_row_2())).hiddenEditedCellKeys)
                .toEqual(['9:0']);
        });

        it('ignores keys that name no cell', async () => {
            const { install } = counting_core(['0:', ':', 'nonsense', '4', '4:0']);

            expect((await install('filter', keeps_only_row_2())).hiddenEditedCellKeys)
                .toEqual(['4:0']);
        });

        it('reports none with no provider wired at all', async () => {
            // Excel and every other non-editing caller: no dirty map exists, so the
            // record still has to be truthful rather than absent.
            const { panel, posted } = make_panel();
            const core = new ViewerPanelCore(panel, new StubSource(5));

            await core.handle_message({
                type: 'setTransform',
                sheetIndex: 0,
                requestId: 'no-provider',
                generation: core.generation,
                sourceGeneration: core.source_generation,
                intent: 'user',
                state: keeps_only_row_2(),
            });

            const view = (posted.find(
                (message) => message.type === 'transformInstalled',
            ).view) as SheetViewRecord;
            if (!view.permuted) throw new Error('expected a permuted view');
            expect(view.rowCount).toBe(1);
            expect(view.hiddenEditedCellKeys).toEqual([]);
        });
    });

    /**
     * The memo over the display-keyed row-height projection.
     *
     * Counted through `display_row_for_source`, which the projection calls exactly once
     * per durable override entry and which nothing else in these cases calls at all —
     * there is no `durablePendingEditKeys` provider, so the hidden-key scan never enters
     * its loop. The call count is therefore the number of recomputations, which is the
     * thing under test: the delivered values are identical with or without the memo, so a
     * test that only compared values would pass with the memo deleted.
     */
    describe('rowHeightProjection memoization', () => {
        function projection_core(overrides: Record<number, number> = { 2: 44 }) {
            const { panel, posted } = make_panel();
            const durable: {
                revision: number;
                heights: (Record<number, number> | undefined)[];
            } = { revision: 1, heights: [overrides] };
            const core = new ViewerPanelCore(panel, new StubSource(5), {
                durableRowHeights: () => durable,
            });
            const scans = vi.spyOn(core, 'display_row_for_source');
            const sort = async (requestId: string) => {
                await core.handle_message({
                    type: 'setTransform',
                    sheetIndex: 0,
                    requestId,
                    generation: core.generation,
                    sourceGeneration: core.source_generation,
                    intent: 'user',
                    state: {
                        sort: [{ colIndex: 0, direction: 'desc' }],
                        filters: [],
                        schema: '["Sheet1",2,null]',
                    },
                });
                return posted.filter((m) => m.type === 'transformInstalled').at(-1);
            };
            return { core, durable, scans, sort };
        }

        it('recomputes once for a run of deliveries on one generation and revision', () => {
            const { core, scans } = projection_core();

            expect(core.snapshot_material().core.rowHeightProjection).toEqual([{ 2: 44 }]);
            const first = scans.mock.calls.length;
            expect(first).toBeGreaterThan(0);

            // Deliveries are triggered by scrolling, focus and sibling writes among
            // others, so a run like this is the ordinary case rather than a stress case.
            // Releases before `MAX_PERSISTED_ROW_HEIGHTS` existed could persist a
            // select-all map, so "walk the map on every delivery" can be a walk over
            // millions of entries already on disk — which is why a bound applied only to
            // new writes does not fix the cost on its own.
            for (let i = 0; i < 5; i += 1) {
                expect(core.snapshot_material().core.rowHeightProjection)
                    .toEqual([{ 2: 44 }]);
            }

            expect(scans.mock.calls.length).toBe(first);
        });

        it('recomputes when the durable revision moves with no generation change', () => {
            // The half a generation key cannot see: a `setRowHeights`, a sibling panel's
            // write and an excel-header plan edit all land as a new state revision, and
            // none of them installs a view.
            const { core, durable, scans } = projection_core();
            core.snapshot_material();
            const first = scans.mock.calls.length;

            durable.heights = [{ 3: 55 }];
            durable.revision = 2;

            expect(core.snapshot_material().core.rowHeightProjection).toEqual([{ 3: 55 }]);
            expect(scans.mock.calls.length).toBeGreaterThan(first);
        });

        it('recomputes when an install moves the rows under an unchanged revision', async () => {
            // The other half, and the one where a wrong answer is silent rather than
            // merely stale: the durable map has not moved, but source row 4 is at display
            // row 0 under a descending sort, so a memo keyed on the revision alone would
            // paint the height on whatever row 4 used to be.
            const { core, scans, sort } = projection_core({ 4: 44 });
            expect(core.snapshot_material().core.rowHeightProjection).toEqual([{ 4: 44 }]);
            const first = scans.mock.calls.length;

            const installed = await sort('desc');

            expect(scans.mock.calls.length).toBeGreaterThan(first);
            expect(installed.rowHeights).toEqual({ 0: 44 });
            expect(core.snapshot_material().core.rowHeightProjection).toEqual([{ 0: 44 }]);
        });

        it('hands out a projection no reader can mutate', async () => {
            // The memo returns the identical object to every reader until its key
            // changes, so a reader that mutated what it got back would be editing the
            // cache and the edit would surface on unrelated later deliveries. The
            // snapshot path publishes the object by reference too now, so both readers
            // would have noticed; the freeze is what makes sharing it safe at all.
            const { core, sort } = projection_core();
            const installed = await sort('desc');

            expect(() => {
                (installed.rowHeights as Record<number, number>)[2] = 99;
            }).toThrow(TypeError);
            expect(core.snapshot_material().core.rowHeightProjection).toEqual([{ 2: 44 }]);
        });

        it('publishes the memoized projection by reference, not as a copy', () => {
            // The memo only pays for itself if the delivery path stops copying what it
            // returns, and `snapshot_material` used to hand the whole material through
            // `deep_clone_and_freeze` — so a legacy select-all map was structured-cloned
            // once per delivery and the memoized walk saved nothing on the path that
            // matters. Identity is the only observable that separates a share from a copy
            // (the *values* are equal either way, which is why the assertions above cannot
            // see this), so identity is what this pins, on both levels of the shape.
            const { core } = projection_core();

            const first = core.snapshot_material().core.rowHeightProjection;
            const second = core.snapshot_material().core.rowHeightProjection;

            expect(second).toBe(first);
            expect(second[0]).toBe(first[0]);
            // And the rest of the material still keeps its clone-and-freeze contract:
            // `meta` comes off the source afresh and must be an isolated frozen copy.
            expect(core.snapshot_material().core.meta)
                .not.toBe(core.snapshot_material().core.meta);
            expect(Object.isFrozen(core.snapshot_material().core)).toBe(true);
        });

        /**
         * The per-sheet layer under the core-wide memo. The outer key moves on events
         * that cannot have changed a given sheet's answer, and the cost of taking it at
         * face value is paid in the one size this design has to stay honest about: a
         * pre-cap legacy map with millions of entries, walked and reallocated
         * synchronously on the acknowledgement path for a sheet nobody touched.
         *
         * Counted the same way as above, but *per sheet* — `display_row_for_source` takes
         * the sheet index as its first argument, so the calls separate cleanly and a test
         * can assert that one sheet recomputed while the other did not. Asserting only
         * the total would pass for an implementation that recomputed the wrong one.
         */
        describe('per-sheet scoping', () => {
            function two_sheet_core(
                heights: (Record<number, number> | undefined)[] = [{ 1: 44 }, { 2: 55 }],
            ) {
                const { panel, posted } = make_panel();
                const durable: {
                    revision: number;
                    heights: (Record<number, number> | undefined)[];
                } = { revision: 1, heights };
                const core = new ViewerPanelCore(
                    panel,
                    new TrackingColumnSource(5, 2),
                    { durableRowHeights: () => durable },
                );
                const scans = vi.spyOn(core, 'display_row_for_source');
                const scans_for = (sheet: number) => scans.mock.calls
                    .filter((call) => call[0] === sheet).length;
                const sort = async (sheetIndex: number, requestId: string) => {
                    await core.handle_message({
                        type: 'setTransform',
                        sheetIndex,
                        requestId,
                        generation: core.generation,
                        sourceGeneration: core.source_generation,
                        intent: 'user',
                        state: {
                            sort: [{ colIndex: 0, direction: 'desc' }],
                            filters: [],
                            schema: `["Sheet${sheetIndex + 1}",3,null]`,
                        },
                    });
                    return posted.filter((m) => m.type === 'transformInstalled').at(-1);
                };
                return { core, durable, posted, scans_for, sort };
            }

            it('holds a sheet\'s mapping generation when an install permutes nothing', async () => {
                // A filter added but left disabled changes the rules — so the core-wide
                // generation must move, and the ack must carry it — but `compute_transform`
                // returns no indices and the sheet had none, so display row `r` is still
                // source row `r`. A resize already in flight against the previous
                // generation still names exactly the rows it meant, and the host's
                // admission rule is `msg.generation >= mapping_generation(sheet)`. If this
                // moved, that resize would be refused and the webview — told its sheet's
                // mapping had moved — would throw the optimistic layer away with it.
                const { core, posted } = two_sheet_core();
                const mapping_before = core.mapping_generation(0);
                const generation_before = core.generation;

                await core.handle_message({
                    type: 'setTransform',
                    sheetIndex: 0,
                    requestId: 'disabled-filter',
                    generation: core.generation,
                    sourceGeneration: core.source_generation,
                    intent: 'user',
                    state: {
                        sort: [],
                        filters: [{
                            id: 'f1',
                            colIndex: 0,
                            operator: 'contains',
                            value: 'z',
                            caseSensitive: false,
                            enabled: false,
                        }],
                        schema: '["Sheet1",3,null]',
                    },
                });

                expect(core.generation).toBeGreaterThan(generation_before);
                expect(core.mapping_generation(0)).toBe(mapping_before);
                // And the projection the held generation now licenses the memo to reuse is
                // the right one. Holding the generation is only safe because absent →
                // absent leaves display↔source as the identity on both sides; if that were
                // ever untrue the memo would serve a stale projection and nothing else
                // here would notice.
                expect(core.snapshot_material().core.rowHeightProjection[0])
                    .toEqual({ 1: 44 });
                // And the ack tells the webview the same scoped fact, not the bumped view
                // generation beside it. Without this the two sides disagree: the host goes
                // on accepting the in-flight resize while the webview, reading the view
                // generation as a mapping change, has already discarded its layer.
                const ack = posted.filter((m) => m.type === 'transformInstalled').at(-1);
                expect(ack.view.basis.generation).toBe(core.generation);
                expect(ack.mappingGeneration).toBe(mapping_before);
            });

            it('moves a sheet\'s mapping generation when an install does permute', async () => {
                // The other direction, so the test above cannot be satisfied by never
                // moving the mapping generation at all.
                const { core, sort } = two_sheet_core();
                const mapping_before = core.mapping_generation(0);

                const installed = await sort(0, 'desc-a');

                expect(core.mapping_generation(0)).toBeGreaterThan(mapping_before);
                // The ack reports the moved value, so the field cannot be satisfied by
                // sending a constant — the sheet's mapping generation before any install.
                expect(installed.mappingGeneration).toBe(core.mapping_generation(0));
                expect(installed.mappingGeneration).toBeGreaterThan(mapping_before);
            });

            it('moves it back when a permuting view is cleared', async () => {
                // Present → absent also moves every display row, and is the case a
                // one-sided check ("next has no indices, so nothing moved") would miss.
                const { core, sort } = two_sheet_core();
                await sort(0, 'desc-a');
                const mapping_after_sort = core.mapping_generation(0);

                await core.handle_message({
                    type: 'setTransform',
                    sheetIndex: 0,
                    requestId: 'clear-a',
                    generation: core.generation,
                    sourceGeneration: core.source_generation,
                    intent: 'user',
                    state: { sort: [], filters: [], schema: '["Sheet1",3,null]' },
                });

                expect(core.mapping_generation(0)).toBeGreaterThan(mapping_after_sort);
            });

            it('leaves an untouched sheet alone when a sibling installs a view', async () => {
                // A sort on sheet B bumps the core-wide generation, which is what the
                // outer memo is keyed on — but sheet A's `mapping_generation` does not
                // move, and its projection is a function of that and its own heights.
                const { core, scans_for, sort } = two_sheet_core();
                core.snapshot_material();
                const sheet_a = scans_for(0);
                expect(sheet_a).toBeGreaterThan(0);

                const installed = await sort(1, 'desc-b');

                // Sheet B genuinely moved: source row 2 sits at display row 2 under a
                // descending sort of 5 rows. The point is that A did not pay for it.
                expect(installed.rowHeights).toEqual({ 2: 55 });
                expect(scans_for(0)).toBe(sheet_a);
                expect(core.snapshot_material().core.rowHeightProjection)
                    .toEqual([{ 1: 44 }, { 2: 55 }]);
                expect(scans_for(0)).toBe(sheet_a);
            });

            it('leaves both sheets alone when an unrelated durable write bumps the revision', () => {
                // `revision` is file-wide: a column resize, a scroll position or a
                // sibling's write all move it while the height maps stay identical. The
                // maps are shared by reference from the latch, so an unchanged identity
                // is the proof that nothing this projection reads has moved.
                const { core, durable, scans_for } = two_sheet_core();
                core.snapshot_material();
                const before = [scans_for(0), scans_for(1)];

                durable.revision = 2;

                expect(core.snapshot_material().core.rowHeightProjection)
                    .toEqual([{ 1: 44 }, { 2: 55 }]);
                expect([scans_for(0), scans_for(1)]).toEqual(before);
            });

            it('recomputes only the sheet whose durable heights actually moved', () => {
                // The other side of the identity check: a revision bump that *does* carry
                // a new map for one sheet must recompute that sheet and only that sheet.
                const { core, durable, scans_for } = two_sheet_core();
                core.snapshot_material();
                const before = [scans_for(0), scans_for(1)];

                durable.revision = 2;
                durable.heights = [durable.heights[0], { 3: 66 }];

                expect(core.snapshot_material().core.rowHeightProjection)
                    .toEqual([{ 1: 44 }, { 3: 66 }]);
                expect(scans_for(0)).toBe(before[0]);
                expect(scans_for(1)).toBeGreaterThan(before[1]);
            });

            it('projects the adopted source rather than the one it replaced', () => {
                // Behaviour, not the cache. The per-sheet drop in `adopt_source` is
                // unfalsifiable for the same reason the whole-memo drop beside it is —
                // adoption raises every sheet's mapping generation above anything the
                // cache holds, so every entry misses whether or not it was cleared — and
                // this deliberately does not pretend otherwise. What it does pin is the
                // outcome that would be catastrophic if the narrowing were ever taken
                // further: after adoption the projection describes the new source.
                const { core, durable } = two_sheet_core([{ 1: 44 }, undefined]);
                expect(core.snapshot_material().core.rowHeightProjection)
                    .toEqual([{ 1: 44 }, undefined]);

                durable.revision = 2;
                durable.heights = [{ 3: 77 }, undefined];
                core.adopt_source(new TrackingColumnSource(5, 2));

                expect(core.snapshot_material().core.rowHeightProjection)
                    .toEqual([{ 3: 77 }, undefined]);
            });
        });

        it('asks for the projection indexed against its own source sheets', () => {
            // The provider is handed sheet names rather than assuming an index array,
            // because a legacy durable map is keyed by sheet *name* and only the core
            // knows which sheets, in which order, those names have to line up with.
            const { panel } = make_panel();
            const asked: (readonly string[])[] = [];
            const core = new ViewerPanelCore(panel, new TrackingColumnSource(5, 2), {
                durableRowHeights: (names) => {
                    asked.push(names);
                    return { revision: 1, heights: [] };
                },
            });

            core.snapshot_material();

            expect(asked).toEqual([['Sheet1', 'Sheet2']]);
        });
    });

    /**
     * What `compute_row_height_projection` refuses to project, as opposed to how often it
     * recomputes. Each of these is a durable entry that has no display row to name, and
     * the failure mode they share is the dangerous one: not a missing height but a height
     * painted on some *other* row, which looks like a height the user set and is not.
     */
    describe('rowHeightProjection entry filtering', () => {
        function core_with(
            heights: Record<number, number>,
        ): { core: ViewerPanelCore; hide: (rows: number[]) => Promise<void> } {
            const { panel } = make_panel();
            const core = new ViewerPanelCore(panel, new StubSource(5), {
                durableRowHeights: () => ({ revision: 1, heights: [heights] }),
            });
            return {
                core,
                hide: async (rows) => {
                    await core.handle_message({
                        type: 'setTransform',
                        sheetIndex: 0,
                        requestId: 'hide',
                        generation: core.generation,
                        sourceGeneration: core.source_generation,
                        intent: 'user',
                        state: {
                            sort: [],
                            filters: [],
                            hiddenRows: rows,
                            schema: '["Sheet1",2,null]',
                        },
                    });
                },
            };
        }

        it('omits a source row the installed view does not contain', async () => {
            // Source row 2 hidden: it has no display row at all, while source row 4 moves
            // up to display row 3. Keeping the hidden entry under its source key — the
            // natural slip, since the two spaces agree until something moves — would paint
            // hidden row 2's height on whatever row is at display 2 now, and the entry
            // that *is* in view proves the projection is not simply passing keys through.
            const { core, hide } = core_with({ 2: 44, 4: 55 });
            await hide([2]);

            expect(core.snapshot_material().core.rowHeightProjection).toEqual([{ 3: 55 }]);
        });

        it('skips a key no writer could have produced', () => {
            // The same canonicality test `layout-state-patch.ts` applies to these maps.
            // `Number('01')` is 1, so coercing would move a height onto row 1 — a row the
            // user never resized — and `Number('1.5')` would key the projection at 1.5,
            // which no `rowHeight(row)` lookup can ever hit.
            const { core } = core_with({
                0: 40,
                '01': 30,
                '1.5': 22,
                '-1': 21,
            } as unknown as Record<number, number>);

            expect(core.snapshot_material().core.rowHeightProjection).toEqual([{ 0: 40 }]);
        });

        it('skips a height that is not a finite number', () => {
            // Durable state is JSON a previous version (or a hand edit) wrote, so `null`
            // is reachable where `NaN` is not. Projected through, it reaches Glide's
            // `rowHeight` callback and the row collapses — and so does every total scroll
            // height computed from it.
            const { core } = core_with({
                0: 40,
                1: null as unknown as number,
                2: Number.NaN,
            });

            expect(core.snapshot_material().core.rowHeightProjection).toEqual([{ 0: 40 }]);
        });

        it('clamps a durable height the bound was never applied to', () => {
            // Unlike the two above this is not a key with no row — it is a real row with
            // an out-of-range height, so dropping it would lose a height the user set.
            // Every *write* path clamps, but the durable map is not something this
            // version wrote: releases before the bound existed persisted whatever
            // arithmetic produced, and a state file is editable besides.
            //
            // The floor is the half that is not merely cosmetic. A row at zero or a
            // negative height renders with no edge to grab, and there is no UI that
            // deletes a height entry — so without this the file puts the row beyond the
            // user's reach permanently. The ceiling keeps Glide's total-scroll-height
            // sum, which adds `rowHeight(r)` over every row, from being dominated by one
            // absurd entry.
            //
            // Values are asserted exactly rather than by range: the webview reconciles
            // its optimistic overlay against this projection *by value*, so the number
            // here has to be the same number `clamp_row_height` produces on the write
            // side, not merely one inside the bounds.
            const { core } = core_with({
                0: -50,
                1: 0,
                2: 1e9,
                3: 44,
            });

            expect(core.snapshot_material().core.rowHeightProjection).toEqual([{
                0: MIN_ROW_HEIGHT_PX,
                1: MIN_ROW_HEIGHT_PX,
                2: MAX_ROW_HEIGHT_PX,
                3: 44,
            }]);
        });
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

    it('charges retained string allocations to analysis admission', async () => {
        const { panel } = make_panel();
        const source = new TrackingColumnSource(
            10,
            1,
            1,
            (_sheet, _column, row) => String.fromCharCode('a'.charCodeAt(0) + row),
        );
        const core = new ViewerPanelCore(panel, source, {
            maxCachedTransformCells: 100,
            maxCachedTransformBytes: 2_000,
        });
        const apply = async (direction: 'asc' | 'desc', requestId: string) => {
            await core.handle_message({
                type: 'setTransform', sheetIndex: 0, requestId,
                generation: core.generation, sourceGeneration: core.source_generation,
                intent: 'user', state: {
                    sort: [{ colIndex: 0, direction }], filters: [],
                    schema: '["Sheet1",1,null]',
                },
            });
        };

        await apply('asc', 'first');
        await apply('desc', 'second');

        expect(source.column_reads.map((read) => read.columns)).toEqual([[0], [0]]);
    });

    it('rejects an individually oversized analysis without evicting retained entries', async () => {
        const { panel } = make_panel();
        const source = new TrackingColumnSource(
            2,
            1,
            2,
            (_sheet, column) => column === 0 ? 'x' : 'x'.repeat(200),
        );
        const core = new ViewerPanelCore(panel, source, {
            maxCachedTransformCells: 100,
            maxCachedTransformBytes: 1_500,
        });
        const apply = async (column: number, requestId: string) => {
            await core.handle_message({
                type: 'setTransform', sheetIndex: 0, requestId,
                generation: core.generation, sourceGeneration: core.source_generation,
                intent: 'user', state: {
                    sort: [{ colIndex: column, direction: 'asc' }], filters: [],
                    schema: '["Sheet1",2,null]',
                },
            });
        };

        await apply(0, 'short');
        await apply(1, 'long');
        await apply(0, 'short-cached');
        await apply(1, 'long-reread');

        expect(source.column_reads.map((read) => read.columns)).toEqual([
            [0], [1], [1],
        ]);
    });

    it('bounds aggregate analysis bytes with LRU recency', async () => {
        const { panel } = make_panel();
        const lengths = [1, 20, 30];
        const source = new TrackingColumnSource(
            2,
            1,
            3,
            (_sheet, column) => 'x'.repeat(lengths[column]),
        );
        const core = new ViewerPanelCore(panel, source, {
            maxCachedTransformCells: 100,
            maxCachedTransformBytes: 1_500,
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
        await apply(1, 'one-reread');

        expect(source.column_reads.map((read) => read.columns)).toEqual([
            [0], [1], [2], [1],
        ]);
    });

    it('does not touch an incomplete entry when an oversized upgrade is rejected', async () => {
        const { panel } = make_panel();
        const identity = `identity:${'i'.repeat(400)}`;
        const source = new TrackingDeferredIdentityColumnSource(identity);
        const core = new ViewerPanelCore(panel, source, {
            maxCachedTransformCells: 100,
            maxCachedTransformBytes: 1_300,
        });
        const sort = async (column: number, requestId: string) => {
            await core.handle_message({
                type: 'setTransform', sheetIndex: 0, requestId,
                generation: core.generation, sourceGeneration: core.source_generation,
                intent: 'user', state: {
                    sort: [{ colIndex: column, direction: 'asc' }], filters: [],
                    schema: '["Sheet1",3,null]',
                },
            });
        };

        await sort(0, 'incomplete-a');
        await sort(1, 'retain-b');
        await core.handle_message({
            type: 'setTransform', sheetIndex: 0, requestId: 'upgrade-a',
            generation: core.generation, sourceGeneration: core.source_generation,
            intent: 'user', state: {
                sort: [], filters: [{
                    id: 'identity-a', colIndex: 0, operator: 'isOneOf',
                    excludedValues: [identity], caseSensitive: false, enabled: true,
                }], schema: '["Sheet1",3,null]',
            },
        });
        await sort(2, 'admit-c');
        await sort(1, 'reuse-b');

        expect(source.resolve_calls).toBe(2);
        expect(source.column_reads.map((read) => read.columns)).toEqual([
            [0], [1], [0], [2],
        ]);
    });

    it('charges filter-identity slots to the transform-column cache bound', async () => {
        const { panel } = make_panel();
        const source = new TrackingIdentityColumnSource(3);
        const core = new ViewerPanelCore(panel, source, {
            // One three-row column with both values arrays exactly fills the cache.
            maxCachedTransformCells: 6,
        });
        const apply = async (
            column: number,
            requestId: string,
            categorical: boolean,
        ) => {
            await core.handle_message({
                type: 'setTransform', sheetIndex: 0, requestId,
                generation: core.generation, sourceGeneration: core.source_generation,
                intent: 'user', state: {
                    sort: categorical ? [] : [{ colIndex: column, direction: 'asc' }],
                    filters: categorical ? [{
                        id: `filter-${column}`,
                        colIndex: column,
                        operator: 'isOneOf',
                        excludedValues: ['identity:missing'],
                        caseSensitive: false,
                        enabled: true,
                    }] : [],
                    schema: '["Sheet1",3,null]',
                },
            });
        };

        await apply(0, 'identity-zero', true);
        await apply(1, 'identity-one', false);
        await apply(0, 'identity-zero-again', true);

        expect(source.column_reads.map((read) => read.columns)).toEqual([
            [0], [1], [0],
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

        const refused = posted.find((message) => message.type === 'transformRefused');
        expect(refused.requestId).toBe('bad');
        expect(refused.reason).toContain('column index 99 out of range');
        expect(refused.terminal).toBe(true);
        // The refusal carries nothing about the view, so the rollback is asserted
        // against the core itself: nothing installed and the generation held.
        expect(core.transform_state(0)).toEqual({ sort: [], filters: [] });
        expect(core.generation).toBe(generation);
    });

    it('offers only invalid numeric restores for durable cleanup and suppresses a recovered warning', async () => {
        const { panel, posted } = make_panel();
        const failures: InvalidPersistedTransformError[] = [];
        const core = new ViewerPanelCore(panel, new StubSource(5), {
            onInvalidRestore: async (_message, error) => {
                failures.push(error);
                return true;
            },
        });
        const state = {
            sort: [],
            filters: [{
                id: 'bad', colIndex: 0, operator: 'greaterThan' as const,
                value: 'nope', caseSensitive: false, enabled: true,
            }],
            schema: '["Sheet1",2,null]',
        };

        await core.handle_message({
            type: 'setTransform', sheetIndex: 0, requestId: 'restore',
            generation: core.generation, sourceGeneration: core.source_generation,
            intent: 'restore', state,
        });

        expect(failures).toHaveLength(1);
        expect(failures[0]).toMatchObject({
            sheetIndex: 0,
            invalidState: state,
            retainedState: { sort: [], filters: [] },
            operandError: { filterId: 'bad', operand: 'value' },
        });
        // A recovered invalid restore is answered as an install of the view that
        // stands, not as a refusal: there is nothing left to warn about.
        expect(transform_answers(posted).map((message) => message.type))
            .toEqual(['transformInstalled']);

        await core.handle_message({
            type: 'setTransform', sheetIndex: 0, requestId: 'user',
            generation: core.generation, sourceGeneration: core.source_generation,
            intent: 'user', state,
        });
        expect(failures).toHaveLength(1);
        expect(posted.find((message) =>
            message.type === 'transformRefused' && message.requestId === 'user')?.reason)
            .toContain('finite numbers');
    });

    it('preserves an installed valid transform when a user submits an invalid numeric filter', async () => {
        const { panel, posted } = make_panel();
        const core = new ViewerPanelCore(panel, new StubSource(5));
        const valid = {
            sort: [{ colIndex: 0, direction: 'desc' as const }],
            filters: [],
            schema: '["Sheet1",2,null]',
        };
        await core.handle_message({
            type: 'setTransform', sheetIndex: 0, requestId: 'valid',
            generation: core.generation, sourceGeneration: core.source_generation,
            intent: 'user', state: valid,
        });
        const installed_generation = core.generation;
        await core.handle_message({
            type: 'setTransform', sheetIndex: 0, requestId: 'invalid-user',
            generation: core.generation, sourceGeneration: core.source_generation,
            intent: 'user', state: {
                sort: [], filters: [{
                    id: 'bad', colIndex: 0, operator: 'greaterThan', value: 'bad',
                    caseSensitive: false, enabled: true,
                }], schema: valid.schema,
            },
        });

        const rejected = posted.find((message) =>
            message.type === 'transformRefused' && message.requestId === 'invalid-user');
        expect(rejected?.reason).toContain('finite numbers');
        // The valid view is preserved in the core, which is now the only place a
        // refusal lets anyone look for it.
        expect(core.transform_state(0)).toEqual(valid);
        expect(core.generation).toBe(installed_generation);
    });

    it('keeps the prior valid view and reports an invalid restore when cleanup fails', async () => {
        const { panel, posted } = make_panel();
        const cleanup = vi.fn(async () => false);
        const core = new ViewerPanelCore(panel, new StubSource(5), {
            onInvalidRestore: cleanup,
        });
        const valid = {
            sort: [{ colIndex: 0, direction: 'desc' as const }],
            filters: [], schema: '["Sheet1",2,null]',
        };
        await core.handle_message({
            type: 'setTransform', sheetIndex: 0, requestId: 'valid-baseline',
            generation: core.generation, sourceGeneration: core.source_generation,
            intent: 'user', state: valid,
        });
        await core.handle_message({
            type: 'setTransform', sheetIndex: 0, requestId: 'failed-restore-cleanup',
            generation: core.generation, sourceGeneration: core.source_generation,
            intent: 'restore', state: {
                sort: [], filters: [{
                    id: 'bad', colIndex: 0, operator: 'greaterThan', value: 'bad',
                    caseSensitive: false, enabled: true,
                }], schema: valid.schema,
            },
        });

        expect(cleanup).toHaveBeenCalledOnce();
        const failed = posted.find((message) =>
            message.type === 'transformRefused'
            && message.requestId === 'failed-restore-cleanup');
        expect(failed?.reason).toContain('finite numbers');
        expect(core.transform_state(0)).toEqual(valid);
    });

    it('does not request invalid-restore cleanup after receiver cancellation', async () => {
        const { panel, posted } = make_panel();
        const cleanup = vi.fn(async () => true);
        const core = new ViewerPanelCore(panel, new StubSource(5), {
            onInvalidRestore: cleanup,
        });
        core.begin_receiver_epoch(1);
        const restore = core.handle_message({
            type: 'setTransform', sheetIndex: 0, requestId: 'cancelled-restore',
            generation: core.generation, sourceGeneration: core.source_generation,
            intent: 'restore', state: {
                sort: [], filters: [{
                    id: 'bad', colIndex: 0, operator: 'greaterThan', value: 'bad',
                    caseSensitive: false, enabled: true,
                }], schema: '["Sheet1",2,null]',
            },
        });
        core.begin_receiver_epoch(2);
        await restore;

        expect(cleanup).not.toHaveBeenCalled();
        expect(transform_answers(posted)).toEqual([]);
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

        const refused = posted.find((message) =>
            message.type === 'transformRefused');
        expect(refused.reason).toContain('source changed');
        expect(core.transform_state(0)).toEqual({ sort: [], filters: [] });
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

        expect(transform_answers(posted).map((message) => message.requestId))
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
        expect(transform_answers(posted)).toEqual([]);
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
        expect(transform_answers(posted)).toEqual([]);
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
        expect(transform_answers(posted)).toEqual([]);
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
            type: 'transformRefused',
            requestId: 'source-abort',
            reason: 'source aborted unexpectedly',
            terminal: true,
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

    it('records a mapping generation per sheet, not one for the whole core', async () => {
        // `generation` is core-wide, but `transform_indices` is written per sheet, so an
        // install on one sheet moves the counter without moving a display row anywhere
        // else. `mapping_generation` is what lets a display-keyed request be judged against
        // the arrangement of the sheet it actually names — without it, a resize on the sheet
        // the user is looking at dies because a background sheet finished a sort.
        const { panel } = make_panel();
        const core = new ViewerPanelCore(panel, new TrackingColumnSource(5, 3));
        expect([0, 1, 2].map((sheet) => core.mapping_generation(sheet)))
            .toEqual([1, 1, 1]);

        await core.handle_message({
            type: 'setTransform',
            sheetIndex: 1,
            requestId: 'sort-sheet-1',
            generation: core.generation,
            sourceGeneration: core.source_generation,
            intent: 'user',
            state: {
                sort: [{ colIndex: 0, direction: 'desc' }],
                filters: [],
                schema: '["Sheet2",3,null]',
            },
        });

        expect(core.generation).toBe(2);
        // Only sheet 1 moved. The other two are still answerable at the generation a
        // webview held before this install, which is the whole point.
        expect([0, 1, 2].map((sheet) => core.mapping_generation(sheet)))
            .toEqual([1, 2, 1]);
    });

    it('gives each reconciled sheet its own generation, not the last one bumped', async () => {
        // A reconciliation can carry changes for several sheets and bumps the generation
        // once per change. Recorded after the loop, or from one shared value, the sheet
        // reconciled *first* would inherit the generation of the sheet reconciled after it
        // — and would then refuse a request quoting its own install, the very arrangement
        // it still has.
        const { panel } = make_panel();
        const core = new ViewerPanelCore(panel, new TrackingColumnSource(5, 3));
        core.begin_receiver_epoch(1);
        const desc = (name: string) => ({
            sort: [{ colIndex: 0, direction: 'desc' as const }],
            filters: [],
            schema: `["${name}",3,null]`,
        });
        const prepared = await core.prepare_transform_reconciliation(
            [desc('Sheet1'), undefined, desc('Sheet3')],
            () => false,
        );

        expect(core.commit_transform_reconciliation(prepared!)).toBe(true);

        expect(core.generation).toBe(3);
        expect([0, 1, 2].map((sheet) => core.mapping_generation(sheet)))
            .toEqual([2, 1, 3]);
    });

    it('delivers the same mapping generations the write predicate answers', async () => {
        // The webview judges its display-keyed row-height overlay by the delivered array
        // and the host judges the matching write by `mapping_generation`. If those two
        // disagree the row either springs back while the write is accepted, or keeps
        // painting a height nothing persisted — so the array is built by *calling* the
        // predicate, and this is the assertion that the sparse map and its floor are not
        // being re-merged by a second implementation that could drift.
        const { panel } = make_panel();
        const core = new ViewerPanelCore(panel, new TrackingColumnSource(5, 3));
        core.begin_receiver_epoch(1);
        // A deliberately mixed state: one sheet with an entry in the sparse map, two
        // answered only by the floor.
        await core.handle_message({
            type: 'setTransform',
            sheetIndex: 2,
            requestId: 'sort-sheet-2',
            generation: core.generation,
            sourceGeneration: core.source_generation,
            intent: 'user',
            state: {
                sort: [{ colIndex: 0, direction: 'desc' }],
                filters: [],
                schema: '["Sheet3",3,null]',
            },
        });

        const delivered = core.snapshot_material().core.mappingGenerations;

        expect([...delivered]).toEqual([1, 1, 2]);
        // One entry per sheet the source has, positionally matching `meta.sheets`, and
        // equal to the predicate at every index.
        expect(delivered).toHaveLength(core.snapshot_material().core.meta.sheets.length);
        expect([...delivered]).toEqual(
            [0, 1, 2].map((sheet) => core.mapping_generation(sheet)),
        );
    });

    it('raises every sheet\'s mapping generation on source adoption', async () => {
        // Adoption replaces the rows themselves, so it invalidates every sheet at once and
        // no per-sheet exemption may survive it. Carried as a floor rather than an entry
        // per sheet because a new source can have a different sheet *count* — there is no
        // set of indices to enumerate, and a leftover entry would license a display-keyed
        // request against rows that are gone.
        const { panel } = make_panel();
        const core = new ViewerPanelCore(panel, new TrackingColumnSource(5, 3));
        await core.handle_message({
            type: 'setTransform',
            sheetIndex: 1,
            requestId: 'sort-sheet-1',
            generation: core.generation,
            sourceGeneration: core.source_generation,
            intent: 'user',
            state: {
                sort: [{ colIndex: 0, direction: 'desc' }],
                filters: [],
                schema: '["Sheet2",3,null]',
            },
        });
        expect(core.mapping_generation(0)).toBe(1);

        core.adopt_source(new TrackingColumnSource(5, 3));

        expect(core.generation).toBe(3);
        expect([0, 1, 2].map((sheet) => core.mapping_generation(sheet)))
            .toEqual([3, 3, 3]);
        // Including a sheet index the new source does not have, which a per-sheet map
        // could not have answered at all.
        expect(core.mapping_generation(7)).toBe(3);
        // And the delivered form says the same, which is the answer to "does adoption need
        // a special case in the webview's retention rule?" — no: every sheet reports having
        // moved at the generation the adoption installed, so the uniform rule voids every
        // overlay. This also pins the *floor* half of the serialisation: the per-sheet map
        // is empty here, so an implementation reading it without falling back would report
        // the initial 1 and license an overlay across a source change.
        expect([...core.snapshot_material().core.mappingGenerations]).toEqual([3, 3, 3]);
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
        expect(transform_answers(posted).some((message) =>
            message.requestId === 'old-source')).toBe(false);
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
        // A no-op ack is an install of the view already in place: truthful by
        // definition, and on an unmoved generation, which is what tells the webview
        // not to fold an open editor for it.
        expect(posted).toContainEqual(expect.objectContaining({
            type: 'transformInstalled',
            requestId: 'cancel-fast',
            view: expect.objectContaining({
                rowCount: 5,
                basis: expect.objectContaining({ generation }),
            }),
        }));
    });

    describe('a commit the host would not make', () => {
        // Two ways `onTransformCommit` can fail, and they want opposite answers. The
        // admission the controller re-asks at the commit boundary is an edit-session
        // phase — a sibling claiming, releasing, or holding the session — and every
        // one of them ends by itself, so the request is worth asking again. Anything
        // else that stops the write is a currency or persistence failure that
        // repeating cannot fix. Before this discrimination existed both arrived as a
        // plain `Error` and the refusal defaulted to terminal, so a lapse told the
        // webview to stop retrying and the user's transform was abandoned when the
        // very next attempt would have succeeded.
        const SORT: SheetTransformState = {
            sort: [{ colIndex: 0, direction: 'asc' }],
            filters: [],
            schema: '["Sheet1",2,null]',
        };

        function refusal(posted: any[], request_id: string) {
            return posted.find((message) => (
                message.type === 'transformRefused'
                && message.requestId === request_id
            ));
        }

        /** Fails only the requests named `failing-…`, so a setup install still lands. */
        function core_whose_commit_throws(error: Error) {
            const { panel, posted } = make_panel();
            const core = new ViewerPanelCore(panel, new StubSource(5), {
                onTransformCommit: async (message) => {
                    if (message.requestId.startsWith('failing')) throw error;
                },
            });
            return { core, posted };
        }

        async function ask(
            core: ViewerPanelCore,
            request_id: string,
            intent: 'user' | 'cancel',
        ) {
            await core.handle_message({
                type: 'setTransform',
                sheetIndex: 0,
                requestId: request_id,
                generation: core.generation,
                sourceGeneration: core.source_generation,
                intent,
                state: SORT,
            });
        }

        it('answers a lapsed commit admission with a transient refusal', async () => {
            const { core, posted } = core_whose_commit_throws(
                new TransformAdmissionLapsedError('Another panel is editing this file.'),
            );

            await ask(core, 'failing-user', 'user');

            expect(refusal(posted, 'failing-user')).toMatchObject({
                terminal: false,
                reason: 'Another panel is editing this file.',
            });
            // A refusal is not an install: nothing was adopted locally either.
            expect(core.transform_state(0)).toEqual({ sort: [], filters: [] });
        });

        it('answers a failed durable write with a terminal refusal', async () => {
            const { core, posted } = core_whose_commit_throws(
                new Error('The source changed before this table view could be saved.'),
            );

            await ask(core, 'failing-user', 'user');

            expect(refusal(posted, 'failing-user')).toMatchObject({
                terminal: true,
                reason: 'The source changed before this table view could be saved.',
            });
            expect(core.transform_state(0)).toEqual({ sort: [], filters: [] });
        });

        /**
         * The other arm. A Cancel whose rules the core already holds skips
         * `compute_transform` entirely and still has to commit — durably, so a
         * close/reopen cannot resurrect the cancelled restore — so it has a second
         * catch block, and the two must agree because the same lapse reaches either.
         * (A `restore` never gets here: `persist_transform_commit` returns for it
         * before any write, so its commit cannot fail at all.)
         */
        async function equal_state_cancel(error: Error) {
            const { core, posted } = core_whose_commit_throws(error);
            await ask(core, 'install', 'user');
            posted.length = 0;
            await ask(core, 'failing-cancel', 'cancel');
            return { core, posted };
        }

        it('keeps an equal-state commit retriable when the admission lapsed', async () => {
            const { core, posted } = await equal_state_cancel(
                new TransformAdmissionLapsedError(
                    'Finishing edit-session work; try again in a moment.',
                ),
            );

            expect(refusal(posted, 'failing-cancel')).toMatchObject({
                terminal: false,
                reason: 'Finishing edit-session work; try again in a moment.',
            });
            // The install that preceded it stands; a refused commit changes nothing.
            expect(core.transform_state(0)).toEqual(SORT);
        });

        it('abandons an equal-state commit whose durable write failed', async () => {
            const { posted } = await equal_state_cancel(
                new Error('The source changed before this table view could be saved.'),
            );

            expect(refusal(posted, 'failing-cancel')).toMatchObject({
                terminal: true,
            });
        });
    });

});
