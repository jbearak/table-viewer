import { describe, expect, it, vi } from 'vitest';
import { CompareDataSource, align_workbook } from '../diff-compare/compare-session';
import {
    DEFERRED_COMPARISON_IDENTITY,
    type ColumnFilterMetadata,
    type DataSource,
    type DeferredCellIdentity,
    type IndexedRawColumns,
    type IndexedRows,
    type RawCell,
    type RawColumnWindow,
    type RenderedCell,
    type WorkbookMeta,
} from '../data-source/interface';
import { ABSENT, type SheetAlignment } from '../diff-compare/row-alignment';
import { cell, FixtureSource } from './helpers/fixture-source';

/** Serves cells verbatim, unlike FixtureSource's string rows, so a test can
 *  give a cell the deferred identity a Stata binary strL carries. */
class StubSource implements DataSource {
    constructor(private readonly rows: RenderedCell[][]) {}

    meta(): WorkbookMeta {
        return {
            hasFormatting: false,
            sheets: [{
                name: 'Sheet1',
                rowCount: this.rows.length,
                sourceRowCount: this.rows.length,
                columnCount: this.rows.reduce((w, r) => Math.max(w, r.length), 0),
                merges: [],
                hasFormatting: false,
            }],
        };
    }

    read_rows(_sheet: number, start_row: number, count: number) {
        return { startRow: start_row, rows: this.rows.slice(start_row, start_row + count) };
    }

    close(): void {}
}

function deferred<T>() {
    let resolve!: (value: T | PromiseLike<T>) => void;
    let reject!: (reason?: unknown) => void;
    const promise = new Promise<T>((done, fail) => {
        resolve = done;
        reject = fail;
    });
    return { promise, resolve, reject };
}

interface RawReadRequest {
    readonly startRow: number;
    readonly count: number;
    readonly columns: readonly number[];
    readonly isCancelled: () => boolean;
}

/** Async raw source with observable reads. Its default raw projection strips
 * display formatting, so formattedBase can only come from a later rendered read. */
class AsyncRawSource implements DataSource {
    readonly rawReads: RawReadRequest[] = [];
    readonly renderedReads: { startRow: number; count: number }[] = [];
    closed = false;

    constructor(
        protected readonly rows: RenderedCell[][],
        protected readonly rawReader?: (request: RawReadRequest) => Promise<RawColumnWindow>,
        protected readonly sheetName = 'Sheet1',
    ) {}

    meta(): WorkbookMeta {
        return {
            hasFormatting: true,
            sheets: [{
                name: this.sheetName,
                rowCount: this.rows.length,
                sourceRowCount: this.rows.length,
                columnCount: this.rows.reduce((width, row) => Math.max(width, row.length), 0),
                merges: [],
                hasFormatting: true,
            }],
        };
    }

    read_rows(_sheet: number, start_row: number, count: number) {
        this.renderedReads.push({ startRow: start_row, count });
        return { startRow: start_row, rows: this.rows.slice(start_row, start_row + count) };
    }

    read_raw_columns_async(
        _sheet: number,
        start_row: number,
        count: number,
        columns: readonly number[],
        is_cancelled: () => boolean,
    ): Promise<RawColumnWindow> {
        const request = {
            startRow: start_row,
            count,
            columns,
            isCancelled: is_cancelled,
        };
        this.rawReads.push(request);
        if (this.rawReader) return this.rawReader(request);
        return Promise.resolve({
            startRow: start_row,
            rows: this.rows.slice(start_row, start_row + count).map((row) =>
                columns.map((column): RawCell | null => {
                    const source = row[column];
                    if (!source) return null;
                    return {
                        raw: source.raw,
                        ...(source.rawType === undefined ? {} : { rawType: source.rawType }),
                        ...(source.comparisonKey === undefined
                            ? {} : { comparisonKey: source.comparisonKey }),
                    };
                })),
        });
    }

    close(): void {
        this.closed = true;
    }
}

interface IndexedRawReadRequest {
    readonly rows: readonly number[];
    readonly columns: readonly number[];
    readonly isCancelled: () => boolean;
}

class IndexedAsyncRawSource extends AsyncRawSource {
    readonly indexedRawReads: IndexedRawReadRequest[] = [];

    constructor(
        rows: RenderedCell[][],
        private readonly indexedReader?: (
            request: IndexedRawReadRequest,
        ) => Promise<IndexedRawColumns>,
        sheet_name = 'Sheet1',
    ) {
        super(rows, undefined, sheet_name);
    }

    read_raw_columns_indexed_async(
        _sheet: number,
        row_indices: ArrayLike<number>,
        columns: readonly number[],
        is_cancelled: () => boolean,
    ): Promise<IndexedRawColumns> {
        const request = { rows: Array.from(row_indices), columns, isCancelled: is_cancelled };
        this.indexedRawReads.push(request);
        if (this.indexedReader) return this.indexedReader(request);
        return Promise.resolve({
            rows: request.rows.map((row) => columns.map((column): RawCell | null => {
                const source = this.rows[row]?.[column];
                return source ? {
                    raw: source.raw,
                    ...(source.rawType === undefined ? {} : { rawType: source.rawType }),
                } : null;
            })),
        });
    }
}

interface IndexedRenderedReadRequest {
    readonly rows: readonly number[];
    readonly isCancelled: () => boolean;
}

class AsyncRenderedSource extends AsyncRawSource {
    readonly indexedRenderedReads: IndexedRenderedReadRequest[] = [];

    constructor(
        rows: RenderedCell[][],
        private readonly indexedRenderedReader?: (
            request: IndexedRenderedReadRequest,
        ) => Promise<IndexedRows>,
        sheet_name = 'Sheet1',
    ) {
        super(rows, undefined, sheet_name);
    }

    read_rows_indexed_async(
        _sheet: number,
        row_indices: ArrayLike<number>,
        is_cancelled: () => boolean,
    ): Promise<IndexedRows> {
        const request = { rows: Array.from(row_indices), isCancelled: is_cancelled };
        this.indexedRenderedReads.push(request);
        if (this.indexedRenderedReader) return this.indexedRenderedReader(request);
        return Promise.resolve({ rows: request.rows.map((row) => this.rows[row] ?? []) });
    }
}

class MetadataSource extends AsyncRawSource {
    readonly metadataReads: { isCancelled: () => boolean }[] = [];
    syncMetadataReads = 0;

    constructor(
        rows: RenderedCell[][],
        private readonly filterMetadata: ColumnFilterMetadata | undefined,
        private readonly metadataReader?: (
            is_cancelled: () => boolean,
        ) => Promise<ColumnFilterMetadata | undefined>,
        sheet_name = 'Sheet1',
    ) {
        super(rows, undefined, sheet_name);
    }

    column_filter_metadata(): ColumnFilterMetadata | undefined {
        this.syncMetadataReads += 1;
        return this.filterMetadata;
    }

    column_filter_metadata_async(
        _sheet: number,
        _column: number,
        is_cancelled: () => boolean,
    ): Promise<ColumnFilterMetadata | undefined> {
        this.metadataReads.push({ isCancelled: is_cancelled });
        return this.metadataReader
            ? this.metadataReader(is_cancelled)
            : Promise.resolve(this.filterMetadata);
    }
}

function with_empty_metadata_column(source: MetadataSource): MetadataSource {
    const metadata = source.meta();
    (source as DataSource).meta = () => ({
        ...metadata,
        sheets: metadata.sheets.map((sheet) => ({ ...sheet, columnCount: 1 })),
    });
    return source;
}

function abort_error(): Error {
    const error = new Error('cancelled');
    error.name = 'AbortError';
    return error;
}

const positional_alignment = (
    changedRowIndices: readonly number[],
    row_count = 1,
): SheetAlignment => ({
    rows: Array.from({ length: row_count }, (_, row) => ({ original: row, modified: row })),
    addedRows: 0,
    deletedRows: 0,
    changedCells: changedRowIndices.length,
    changedRowIndices,
    movedRowIndices: [],
    moveSearchTruncated: false,
    degraded: false,
});

/** The production path serves whole transformed windows via `diff_rows`; these
 *  tests want a plain leading page, so they name the rows themselves, clamped
 *  to the sheet the way a served window already is. */
const diff_page = (
    source: CompareDataSource,
    sheet_index: number,
    count: number,
) => {
    const rows = Math.min(count, source.meta().sheets[sheet_index].rowCount);
    return source.diff_rows(sheet_index, Array.from({ length: rows }, (_, i) => i));
};

const compare = (
    original_rows: string[][],
    modified_rows: string[][],
): CompareDataSource =>
    new CompareDataSource(
        new FixtureSource([{ name: 'Sheet1', rows: modified_rows }]),
        new FixtureSource([{ name: 'Sheet1', rows: original_rows }]),
    );

describe('CompareDataSource', () => {
    it('pads matched sheets to the larger side so deleted rows have grid rows', () => {
        const source = compare([['a'], ['b'], ['c']], [['a']]);
        const sheet = source.meta().sheets[0];
        expect(sheet.rowCount).toBe(3);
        expect(sheet.sourceRowCount).toBe(3);
        const window = source.read_rows(0, 0, 10);
        expect(window.rows).toHaveLength(3);
        expect(window.rows[0][0]?.raw).toBe('a');
        // Deleted-band rows carry the original content, so filters, sorting,
        // copy, and auto-fit see the removed text the grid shows.
        expect(window.rows[1][0]?.raw).toBe('b');
        expect(window.rows[2][0]?.raw).toBe('c');
    });

    it('leaves the modified meta untouched when it is already the larger side', () => {
        const source = compare([['a']], [['a'], ['b']]);
        expect(source.meta().sheets[0].rowCount).toBe(2);
    });

    it('diffs a matched sheet cell by cell, and a one-sided one as a whole band', async () => {
        const source = new CompareDataSource(
            new FixtureSource([
                { name: 'Kept', rows: [['x']] },
                { name: 'Added', rows: [['y']] },
            ]),
            new FixtureSource([{ name: 'Kept', rows: [['z']] }]),
        );
        const kept = await diff_page(source, 0, 10);
        expect(kept?.changedCells).toEqual([
            { row: 0, col: 0, base: 'z', formattedBase: 'z' },
        ]);
        // There is no original to compare the added sheet against, so it has no
        // cell-level diff — but it is still all added, and saying nothing left
        // it painted as unchanged.
        expect(await diff_page(source, 1, 10)).toMatchObject({
            rowStatus: ['added'], changedCells: [],
        });
    });

    // A Stata binary strL renders a bounded preview, so two different payloads
    // can share `raw`. Comparison has to resolve the lossless identity, but
    // `base` is shown to the user and must stay the readable preview — never
    // the digest, and never an internal `raw:`/`comparison:` tag.
    it('compares on identity but reports the display text as the base', async () => {
        const preview = 'binary (33 bytes): 0102030405…';
        const binary = (digest: string): RenderedCell => {
            const rendered = cell(preview);
            Object.defineProperty(rendered, DEFERRED_COMPARISON_IDENTITY, {
                value: {
                    cachedKey: () => undefined,
                    resolveKey: async () => `stata-binary:sha256:${digest}:33`,
                },
            });
            return rendered;
        };
        const source = new CompareDataSource(
            new StubSource([[binary('bbbb')]]),
            new StubSource([[binary('aaaa')]]),
        );
        // Same preview, different payloads: caught only via deferred identity.
        // Both user-facing bases stay on the preview; the digest must never cross
        // the compare protocol into paint text.
        const diff = await source.diff_rows(0, [0]);
        expect(diff?.changedCells).toEqual([{
            row: 0,
            col: 0,
            base: preview,
            formattedBase: preview,
        }]);
        expect(JSON.stringify(diff)).not.toContain('stata-binary:sha256:');

        // Identical payloads must stay unchanged rather than diffing on the tag.
        const unchanged = new CompareDataSource(
            new StubSource([[binary('aaaa')]]),
            new StubSource([[binary('aaaa')]]),
        );
        expect((await unchanged.diff_rows(0, [0]))?.changedCells).toEqual([]);
    });

    it('bounds and overlaps deferred cell comparisons', async () => {
        const release = deferred<void>();
        let active = 0;
        let started = 0;
        let max_active = 0;
        const binary = (side: 'original' | 'modified', column: number): RenderedCell => {
            const rendered = cell(`${side}-${column}`);
            const identity: DeferredCellIdentity = {
                cachedKey: () => undefined,
                resolveKey: async () => `${side}-${column}`,
                ...(side === 'original' ? {
                    exactlyEquals: async (
                        _other: DeferredCellIdentity,
                        is_cancelled: () => boolean,
                    ): Promise<boolean> => {
                        active += 1;
                        started += 1;
                        max_active = Math.max(max_active, active);
                        try {
                            await release.promise;
                            if (is_cancelled()) throw abort_error();
                            return false;
                        } finally {
                            active -= 1;
                        }
                    },
                } : {}),
            };
            Object.defineProperty(rendered, DEFERRED_COMPARISON_IDENTITY, {
                value: identity,
            });
            return rendered;
        };
        const columns = Array.from({ length: 12 }, (_, column) => column);
        const source = new CompareDataSource(
            new StubSource([columns.map((column) => binary('modified', column))]),
            new StubSource([columns.map((column) => binary('original', column))]),
        );

        const pending = source.diff_rows(0, [0]);
        let settled = false;
        void pending.finally(() => { settled = true; }).catch(() => {});
        await vi.waitFor(() => expect(started).toBe(4));
        expect(max_active).toBe(4);
        expect(settled).toBe(false);

        release.resolve(undefined);
        const diff = await pending;
        expect(started).toBe(12);
        expect(max_active).toBe(4);
        expect(diff?.changedCells.map(({ row, col, base }) => ({ row, col, base })))
            .toEqual(columns.map((column) => ({
                row: 0,
                col: column,
                base: `original-${column}`,
            })));
    });

    it('yields across a large eager diff page so cancellation can arrive', async () => {
        const column_count = 131_073;
        const raw_row = Array<RawCell>(column_count).fill({ raw: 'same' });
        let cancelled = false;
        let scheduled = false;
        const eager_source = (schedule_cancellation: boolean): DataSource => ({
            meta: () => ({
                hasFormatting: false,
                sheets: [{
                    name: 'Sheet1', rowCount: 1, sourceRowCount: 1,
                    columnCount: column_count, merges: [], hasFormatting: false,
                }],
            }),
            read_rows: (_sheet, start_row) => ({ startRow: start_row, rows: [] }),
            read_raw_columns_indexed_async: async (
                _sheet,
                row_indices,
                _columns,
                _is_cancelled,
            ) => {
                if (schedule_cancellation && !scheduled) {
                    scheduled = true;
                    setImmediate(() => { cancelled = true; });
                }
                return { rows: Array.from(row_indices, () => raw_row) };
            },
            close: () => {},
        });
        const source = new CompareDataSource(
            eager_source(true),
            eager_source(false),
            new Map([[0, positional_alignment([0], 1)]]),
        );

        await expect(source.diff_rows(0, [0], () => cancelled))
            .rejects.toMatchObject({ name: 'AbortError' });
    });

    it('settles deferred comparison peers and preserves a substantive failure', async () => {
        const gates = Array.from({ length: 4 }, () => deferred<boolean>());
        const cancellation_checks: Array<() => boolean> = [];
        const failure = new Error('comparison failed');
        const binary = (side: 'original' | 'modified', column: number): RenderedCell => {
            const rendered = cell(`${side}-${column}`);
            const identity: DeferredCellIdentity = {
                cachedKey: () => undefined,
                resolveKey: async () => `${side}-${column}`,
                ...(side === 'original' ? {
                    exactlyEquals: (
                        _other: DeferredCellIdentity,
                        is_cancelled: () => boolean,
                    ): Promise<boolean> => {
                        cancellation_checks[column] = is_cancelled;
                        return gates[column].promise;
                    },
                } : {}),
            };
            Object.defineProperty(rendered, DEFERRED_COMPARISON_IDENTITY, {
                value: identity,
            });
            return rendered;
        };
        const columns = [0, 1, 2, 3];
        const source = new CompareDataSource(
            new StubSource([columns.map((column) => binary('modified', column))]),
            new StubSource([columns.map((column) => binary('original', column))]),
        );

        const pending = source.diff_rows(0, [0]);
        let settled = false;
        void pending.finally(() => { settled = true; }).catch(() => {});
        const rejection = expect(pending).rejects.toBe(failure);
        await vi.waitFor(() => expect(cancellation_checks).toHaveLength(4));
        gates[0].reject(failure);
        await vi.waitFor(() => {
            expect(cancellation_checks.slice(1).every((cancelled) => cancelled())).toBe(true);
        });
        expect(settled).toBe(false);

        gates.slice(1).forEach((gate) => gate.reject(abort_error()));
        await rejection;
        expect(settled).toBe(true);
    });

    it('keeps Stata value-label text separate from the raw compare base', async () => {
        const labeled = (raw: string, formatted: string): RenderedCell => ({
            raw,
            formatted,
            bold: false,
            italic: false,
            rawType: 'number',
        });
        const source = new CompareDataSource(
            new StubSource([[labeled('2', 'No')]]),
            new StubSource([[labeled('1', 'Yes')]]),
        );

        expect((await source.diff_rows(0, [0]))?.changedCells).toEqual([{
            row: 0,
            col: 0,
            base: '1',
            formattedBase: 'Yes',
        }]);
    });

    it('exposes pairings including added and deleted sheets', () => {
        const source = new CompareDataSource(
            new FixtureSource([{ name: 'New', rows: [] }]),
            new FixtureSource([{ name: 'Gone', rows: [] }]),
        );
        expect(source.pairings).toEqual([
            { status: 'added', name: 'New', modifiedIndex: 0 },
            { status: 'deleted', name: 'Gone', originalIndex: 0 },
        ]);
    });

    it('closes both sides even when the modified close throws', () => {
        const modified = new FixtureSource([{ name: 'Sheet1', rows: [] }]);
        const original = new FixtureSource([{ name: 'Sheet1', rows: [] }]);
        modified.close = () => {
            modified.closed = true;
            throw new Error('boom');
        };
        const source = new CompareDataSource(modified, original);
        expect(() => source.close()).toThrow('boom');
        expect(modified.closed).toBe(true);
        expect(original.closed).toBe(true);
    });

    it('exposes deleted sheets as navigable read-only all-deleted bands', async () => {
        const source = new CompareDataSource(
            new FixtureSource([{ name: 'Kept', rows: [['x']] }]),
            new FixtureSource([
                { name: 'Kept', rows: [['x']] },
                { name: 'Gone', rows: [['g1'], ['g2']] },
            ]),
        );
        const sheets = source.meta().sheets;
        expect(sheets.map((sheet) => sheet.name)).toEqual(['Kept', 'Gone']);
        // The ordering contract: statuses and changed headers are positional
        // against meta().sheets, with deleted originals appended at the end.
        expect(source.sheetStatuses).toEqual(['matched', 'deleted']);
        expect(source.changedColumnNames).toEqual([[], []]);
        expect(sheets[1].rowCount).toBe(2);
        const window = source.read_rows(1, 0, 10);
        expect(window.rows.map((row) => row[0]?.raw)).toEqual(['g1', 'g2']);
        expect(source.read_rows_indexed(1, [1]).rows[0][0]?.raw).toBe('g2');
        expect((await source.diff_rows(1, [0, 1]))?.rowStatus)
            .toEqual(['deleted', 'deleted']);
    });

    it('bands an added sheet the way it bands a deleted one', async () => {
        // An added sheet has no original to align against, so it has no
        // alignment — and used to fall through to no diff at all, leaving a
        // wholly new sheet painted as ordinary unchanged rows while its tab
        // badge and the summary both called it added.
        const source = new CompareDataSource(
            new FixtureSource([
                { name: 'Kept', rows: [['x']] },
                { name: 'Fresh', rows: [['f1'], ['f2']] },
            ]),
            new FixtureSource([{ name: 'Kept', rows: [['x']] }]),
        );
        expect(source.sheetStatuses).toEqual(['matched', 'added']);
        expect((await source.diff_rows(1, [0, 1]))?.rowStatus)
            .toEqual(['added', 'added']);
        // Undefined is the compact all-rows sentinel for a one-sided sheet.
        expect(source.changed_grid_rows(1)).toBeUndefined();
    });

    it('serves repeated diff_rows requests from the cache', async () => {
        const original = new FixtureSource([{ name: 'Sheet1', rows: [['a']] }]);
        const source = new CompareDataSource(
            new FixtureSource([{ name: 'Sheet1', rows: [['b']] }]),
            original,
        );
        const first = await source.diff_rows(0, [0]);
        let reads = 0;
        const read_rows = original.read_rows.bind(original);
        original.read_rows = (...read_args) => {
            reads += 1;
            return read_rows(...read_args);
        };
        expect(await source.diff_rows(0, [0])).toBe(first);
        expect(reads).toBe(0);
    });

    it('rejects an oversized diff page without evicting cached work', async () => {
        const source = new CompareDataSource(
            new FixtureSource([{ name: 'Sheet1', rows: [['b'], ['changed']] }]),
            new FixtureSource([{
                name: 'Sheet1', rows: [['a'], ['x'.repeat(100)]],
            }]),
            new Map(),
            300,
        );
        const internals = source as unknown as {
            diff_cache: Map<string, { window: unknown; bytes: number }>;
            diff_cache_bytes: number;
        };

        await source.diff_rows(0, [0]);
        expect([...internals.diff_cache.keys()]).toEqual(['0:0']);
        const retained = internals.diff_cache_bytes;

        await source.diff_rows(0, [1]);
        expect([...internals.diff_cache.keys()]).toEqual(['0:0']);
        expect(internals.diff_cache_bytes).toBe(retained);
    });

    it('evicts diff pages when their aggregate byte charge exceeds the cap', async () => {
        const source = new CompareDataSource(
            new FixtureSource([{ name: 'Sheet1', rows: [['b'], ['d']] }]),
            new FixtureSource([{
                name: 'Sheet1',
                rows: [['a'.repeat(40)], ['c'.repeat(40)]],
            }]),
            new Map(),
            500,
        );
        const internals = source as unknown as {
            diff_cache: Map<string, { window: unknown; bytes: number }>;
            diff_cache_bytes: number;
        };

        await source.diff_rows(0, [0]);
        expect([...internals.diff_cache.keys()]).toEqual(['0:0']);
        await source.diff_rows(0, [1]);
        expect([...internals.diff_cache.keys()]).toEqual(['0:1']);
        expect(internals.diff_cache_bytes).toBeLessThanOrEqual(500);

        await source.diff_rows(0, [0]);
        expect([...internals.diff_cache.keys()]).toEqual(['0:0']);
        expect(internals.diff_cache_bytes).toBeLessThanOrEqual(500);
    });

    it('starts both async raw side reads before awaiting either', async () => {
        const original_gate = deferred<RawColumnWindow>();
        const modified_gate = deferred<RawColumnWindow>();
        const original = new AsyncRawSource([[cell('a')]], () => original_gate.promise);
        const modified = new AsyncRawSource([[cell('b')]], () => modified_gate.promise);
        const source = new CompareDataSource(modified, original);

        const pending = source.diff_rows(0, [0]);
        await vi.waitFor(() => {
            expect(original.rawReads).toHaveLength(1);
            expect(modified.rawReads).toHaveLength(1);
        });
        original_gate.resolve({ startRow: 0, rows: [[{ raw: 'a' }]] });
        modified_gate.resolve({ startRow: 0, rows: [[{ raw: 'b' }]] });

        expect((await pending)?.changedCells).toEqual([
            { row: 0, col: 0, base: 'a', formattedBase: 'a' },
        ]);
    });

    it('cancels the sibling raw read after one failure and observes both settlements', async () => {
        const original_gate = deferred<RawColumnWindow>();
        const modified_gate = deferred<RawColumnWindow>();
        const original = new AsyncRawSource([[cell('a')]], () => original_gate.promise);
        const modified = new AsyncRawSource([[cell('b')]], () => modified_gate.promise);
        const source = new CompareDataSource(modified, original);
        const failure = new Error('original raw read failed');

        const pending = source.diff_rows(0, [0]);
        let settled = false;
        void pending.then(
            () => { settled = true; },
            () => { settled = true; },
        );
        const rejection = expect(pending).rejects.toBe(failure);
        await vi.waitFor(() => {
            expect(original.rawReads).toHaveLength(1);
            expect(modified.rawReads).toHaveLength(1);
        });
        original_gate.reject(failure);
        await vi.waitFor(() => expect(modified.rawReads[0].isCancelled()).toBe(true));
        expect(settled).toBe(false);

        modified_gate.reject(abort_error());
        await rejection;
        expect(settled).toBe(true);
    });

    it('reads each contributing aligned side through one indexed request', async () => {
        const original = new IndexedAsyncRawSource([
            [cell('O0')], [cell('O1')], [cell('O2')], [cell('O3')],
        ]);
        const modified = new IndexedAsyncRawSource([[cell('M0')], [cell('M1')]]);
        const alignment: SheetAlignment = {
            rows: [
                { original: 0, modified: 0 },
                { original: 1, modified: ABSENT },
                { original: 2, modified: 1 },
                { original: 3, modified: ABSENT },
            ],
            addedRows: 0,
            deletedRows: 2,
            changedCells: 2,
            changedRowIndices: [0, 2],
            movedRowIndices: [],
            moveSearchTruncated: false,
            degraded: false,
        };
        const source = new CompareDataSource(
            modified,
            original,
            new Map([[0, alignment]]),
        );

        const window = await source.read_raw_columns_async(0, 0, 4, [0], () => false);

        expect(window.rows.map((row) => row[0]?.raw)).toEqual(['M0', 'O1', 'M1', 'O3']);
        expect(modified.indexedRawReads.map((request) => request.rows)).toEqual([[0, 1]]);
        expect(original.indexedRawReads.map((request) => request.rows)).toEqual([[1, 3]]);
    });

    it('settles both aligned indexed reads and cancels the peer after failure', async () => {
        const original_gate = deferred<IndexedRawColumns>();
        const modified_gate = deferred<IndexedRawColumns>();
        const original = new IndexedAsyncRawSource(
            [[cell('O0')], [cell('O1')]],
            () => original_gate.promise,
        );
        const modified = new IndexedAsyncRawSource(
            [[cell('M0')]],
            () => modified_gate.promise,
        );
        const alignment: SheetAlignment = {
            rows: [
                { original: 0, modified: 0 },
                { original: 1, modified: ABSENT },
            ],
            addedRows: 0,
            deletedRows: 1,
            changedCells: 0,
            changedRowIndices: [],
            movedRowIndices: [],
            moveSearchTruncated: false,
            degraded: false,
        };
        const source = new CompareDataSource(modified, original, new Map([[0, alignment]]));
        const failure = new Error('indexed original failed');

        const pending = source.read_raw_columns_async(0, 0, 2, [0], () => false);
        let settled = false;
        void pending.finally(() => { settled = true; }).catch(() => {});
        const rejection = expect(pending).rejects.toBe(failure);
        await vi.waitFor(() => {
            expect(original.indexedRawReads).toHaveLength(1);
            expect(modified.indexedRawReads).toHaveLength(1);
        });
        original_gate.reject(failure);
        await vi.waitFor(() =>
            expect(modified.indexedRawReads[0].isCancelled()).toBe(true));
        expect(settled).toBe(false);
        modified_gate.reject(abort_error());
        await rejection;
        expect(settled).toBe(true);
    });

    it('prevents aligned raw publication after close', async () => {
        const original_gate = deferred<IndexedRawColumns>();
        const modified_gate = deferred<IndexedRawColumns>();
        const original = new IndexedAsyncRawSource(
            [[cell('O0')], [cell('O1')]],
            () => original_gate.promise,
        );
        const modified = new IndexedAsyncRawSource(
            [[cell('M0')]],
            () => modified_gate.promise,
        );
        const alignment: SheetAlignment = {
            rows: [
                { original: 0, modified: 0 },
                { original: 1, modified: ABSENT },
            ],
            addedRows: 0,
            deletedRows: 1,
            changedCells: 0,
            changedRowIndices: [],
            movedRowIndices: [],
            moveSearchTruncated: false,
            degraded: false,
        };
        const source = new CompareDataSource(modified, original, new Map([[0, alignment]]));

        const pending = source.read_raw_columns_async(0, 0, 2, [0], () => false);
        await vi.waitFor(() => {
            expect(original.indexedRawReads).toHaveLength(1);
            expect(modified.indexedRawReads).toHaveLength(1);
        });
        source.close();
        original_gate.resolve({ rows: [[{ raw: 'O1' }]] });
        modified_gate.resolve({ rows: [[{ raw: 'M0' }]] });
        await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    });

    it('merges filter metadata by actual grid contribution', async () => {
        const labels = (values: Record<string, string>): ColumnFilterMetadata['valueLabel'] =>
            (raw) => values[raw];
        const original = new MetadataSource(
            [[cell('1')], [cell('deleted')]],
            {
                categoricalCodes: true,
                valueLabel: labels({ '1': '', '2': 'Original', '3': 'Same', '4': 'Only original' }),
            },
        );
        const modified = new MetadataSource(
            [[cell('1')]],
            {
                categoricalCodes: false,
                valueLabel: labels({ '1': '', '2': 'Modified', '3': 'Same' }),
            },
        );
        const alignment: SheetAlignment = {
            rows: [
                { original: 0, modified: 0 },
                { original: 1, modified: ABSENT },
            ],
            addedRows: 0,
            deletedRows: 1,
            changedCells: 0,
            changedRowIndices: [],
            movedRowIndices: [],
            moveSearchTruncated: false,
            degraded: false,
        };
        const source = new CompareDataSource(modified, original, new Map([[0, alignment]]));

        for (const metadata of [
            source.column_filter_metadata(0, 0),
            await source.column_filter_metadata_async(0, 0, () => false),
        ]) {
            expect(metadata?.categoricalCodes).toBe(true);
            expect(metadata?.valueLabel?.('1')).toBe('');
            expect(metadata?.valueLabel?.('2')).toBeUndefined();
            expect(metadata?.valueLabel?.('3')).toBe('Same');
            expect(metadata?.valueLabel?.('4')).toBeUndefined();
        }
        expect(original.metadataReads).toHaveLength(1);
        expect(modified.metadataReads).toHaveLength(1);
    });

    it('uses only the side whose rows can contribute filter values', async () => {
        const original = new MetadataSource(
            [[cell('old')]],
            { valueLabel: () => 'original' },
        );
        const modified = new MetadataSource(
            [[cell('new')]],
            { valueLabel: () => 'modified' },
        );
        const source = new CompareDataSource(
            modified,
            original,
            new Map([[0, positional_alignment([])]]),
        );

        const paired = await source.column_filter_metadata_async(0, 0, () => false);
        expect(paired?.valueLabel?.('x')).toBe('modified');
        expect(modified.metadataReads).toHaveLength(1);
        expect(original.metadataReads).toHaveLength(0);

        const added = new MetadataSource(
            [[cell('new')]],
            { valueLabel: () => 'added' },
            undefined,
            'Fresh',
        );
        const deleted = new MetadataSource(
            [[cell('old')]],
            { valueLabel: () => 'deleted' },
            undefined,
            'Gone',
        );
        const one_sided = new CompareDataSource(added, deleted);
        expect(one_sided.column_filter_metadata(0, 0)?.valueLabel?.('x')).toBe('added');
        expect(one_sided.column_filter_metadata(1, 0)?.valueLabel?.('x')).toBe('deleted');
    });

    it('does not read filter metadata from empty one-sided sheets', async () => {
        const added = with_empty_metadata_column(new MetadataSource(
            [],
            { categoricalCodes: true, valueLabel: () => 'added' },
            undefined,
            'Fresh',
        ));
        const deleted = with_empty_metadata_column(new MetadataSource(
            [],
            { categoricalCodes: true, valueLabel: () => 'deleted' },
            undefined,
            'Gone',
        ));
        const source = new CompareDataSource(added, deleted);

        expect(source.column_filter_metadata(0, 0)).toBeUndefined();
        expect(source.column_filter_metadata(1, 0)).toBeUndefined();
        await expect(source.column_filter_metadata_async(0, 0, () => false))
            .resolves.toBeUndefined();
        await expect(source.column_filter_metadata_async(1, 0, () => false))
            .resolves.toBeUndefined();
        expect(added.syncMetadataReads).toBe(0);
        expect(deleted.syncMetadataReads).toBe(0);
        expect(added.metadataReads).toHaveLength(0);
        expect(deleted.metadataReads).toHaveLength(0);
    });

    it('retains original filter metadata when only deleted rows contribute', async () => {
        const modified = with_empty_metadata_column(new MetadataSource(
            [],
            { valueLabel: () => 'modified' },
        ));
        const original = new MetadataSource(
            [[cell('deleted')]],
            { categoricalCodes: true, valueLabel: () => 'original' },
        );
        const alignment: SheetAlignment = {
            rows: [{ original: 0, modified: ABSENT }],
            addedRows: 0,
            deletedRows: 1,
            changedCells: 0,
            changedRowIndices: [],
            movedRowIndices: [],
            moveSearchTruncated: false,
            degraded: false,
        };
        const source = new CompareDataSource(modified, original, new Map([[0, alignment]]));

        for (const metadata of [
            source.column_filter_metadata(0, 0),
            await source.column_filter_metadata_async(0, 0, () => false),
        ]) {
            expect(metadata?.categoricalCodes).toBe(true);
            expect(metadata?.valueLabel?.('x')).toBe('original');
        }
        expect(modified.syncMetadataReads).toBe(0);
        expect(modified.metadataReads).toHaveLength(0);
        expect(original.syncMetadataReads).toBe(1);
        expect(original.metadataReads).toHaveLength(1);
    });

    it('counts fallback trailing rows and includes their original metadata', async () => {
        const original = new MetadataSource(
            [[cell('kept')], [cell('deleted')]],
            { categoricalCodes: true, valueLabel: () => 'original' },
        );
        const modified = new MetadataSource(
            [[cell('kept')]],
            { categoricalCodes: false, valueLabel: () => 'modified' },
        );
        const source = new CompareDataSource(modified, original);

        expect(source.change_counts()).toMatchObject({ addedRows: 0, deletedRows: 1 });
        for (const metadata of [
            source.column_filter_metadata(0, 0),
            await source.column_filter_metadata_async(0, 0, () => false),
        ]) {
            expect(metadata?.categoricalCodes).toBe(true);
            expect(metadata?.valueLabel?.('x')).toBeUndefined();
        }
        expect(original.metadataReads).toHaveLength(1);
        expect(modified.metadataReads).toHaveLength(1);
    });

    it('marks a synchronous startup failure before starting its metadata peer', async () => {
        const failure = new Error('modified metadata failed synchronously');
        let original_started_cancelled = false;
        const original = new MetadataSource(
            [[cell('kept')], [cell('deleted')]],
            undefined,
            (is_cancelled) => {
                original_started_cancelled = is_cancelled();
                return Promise.reject(abort_error());
            },
        );
        const modified = new MetadataSource(
            [[cell('kept')]],
            undefined,
            () => { throw failure; },
        );
        const source = new CompareDataSource(modified, original);

        await expect(source.column_filter_metadata_async(0, 0, () => false))
            .rejects.toBe(failure);
        expect(original_started_cancelled).toBe(true);
    });

    it('settles mixed-side metadata peers and fences close', async () => {
        const original_gate = deferred<ColumnFilterMetadata | undefined>();
        const modified_gate = deferred<ColumnFilterMetadata | undefined>();
        const original = new MetadataSource(
            [[cell('old')], [cell('deleted')]],
            undefined,
            () => original_gate.promise,
        );
        const modified = new MetadataSource(
            [[cell('new')]],
            undefined,
            () => modified_gate.promise,
        );
        const alignment: SheetAlignment = {
            rows: [
                { original: 0, modified: 0 },
                { original: 1, modified: ABSENT },
            ],
            addedRows: 0,
            deletedRows: 1,
            changedCells: 0,
            changedRowIndices: [],
            movedRowIndices: [],
            moveSearchTruncated: false,
            degraded: false,
        };
        const source = new CompareDataSource(modified, original, new Map([[0, alignment]]));

        const pending = source.column_filter_metadata_async(0, 0, () => false);
        await vi.waitFor(() => {
            expect(original.metadataReads).toHaveLength(1);
            expect(modified.metadataReads).toHaveLength(1);
        });
        source.close();
        expect(original.metadataReads[0].isCancelled()).toBe(true);
        expect(modified.metadataReads[0].isCancelled()).toBe(true);
        original_gate.resolve({ categoricalCodes: true });
        modified_gate.resolve({ categoricalCodes: true });
        await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    });

    it('waits for a cancelled metadata peer and preserves the substantive failure', async () => {
        const original_gate = deferred<ColumnFilterMetadata | undefined>();
        const modified_gate = deferred<ColumnFilterMetadata | undefined>();
        const original = new MetadataSource(
            [[cell('old')], [cell('deleted')]],
            undefined,
            () => original_gate.promise,
        );
        const modified = new MetadataSource(
            [[cell('new')]],
            undefined,
            () => modified_gate.promise,
        );
        const alignment: SheetAlignment = {
            rows: [
                { original: 0, modified: 0 },
                { original: 1, modified: ABSENT },
            ],
            addedRows: 0,
            deletedRows: 1,
            changedCells: 0,
            changedRowIndices: [],
            movedRowIndices: [],
            moveSearchTruncated: false,
            degraded: false,
        };
        const source = new CompareDataSource(modified, original, new Map([[0, alignment]]));
        const failure = new Error('original metadata failed');

        const pending = source.column_filter_metadata_async(0, 0, () => false);
        let settled = false;
        void pending.finally(() => { settled = true; }).catch(() => {});
        const rejection = expect(pending).rejects.toBe(failure);
        await vi.waitFor(() => {
            expect(original.metadataReads).toHaveLength(1);
            expect(modified.metadataReads).toHaveLength(1);
        });
        original_gate.reject(failure);
        await vi.waitFor(() => {
            expect(modified.metadataReads[0].isCancelled()).toBe(true);
        });
        expect(settled).toBe(false);

        modified_gate.reject(abort_error());
        await rejection;
        expect(settled).toBe(true);
    });

    it('coalesces identical in-flight diff pages', async () => {
        const original_gate = deferred<RawColumnWindow>();
        const modified_gate = deferred<RawColumnWindow>();
        const original = new AsyncRawSource([[cell('a')]], () => original_gate.promise);
        const modified = new AsyncRawSource([[cell('b')]], () => modified_gate.promise);
        const source = new CompareDataSource(modified, original);

        const first = source.diff_rows(0, [0]);
        const second = source.diff_rows(0, [0]);
        await vi.waitFor(() => {
            expect(original.rawReads).toHaveLength(1);
            expect(modified.rawReads).toHaveLength(1);
        });
        original_gate.resolve({ startRow: 0, rows: [[{ raw: 'a' }]] });
        modified_gate.resolve({ startRow: 0, rows: [[{ raw: 'b' }]] });
        const [first_window, second_window] = await Promise.all([first, second]);

        expect(second_window).toBe(first_window);
        expect(original.renderedReads).toEqual([{ startRow: 0, count: 1 }]);
    });

    it('cancels one coalesced waiter without cancelling another live waiter', async () => {
        const original_gate = deferred<RawColumnWindow>();
        const modified_gate = deferred<RawColumnWindow>();
        const original = new AsyncRawSource([[cell('a')]], () => original_gate.promise);
        const modified = new AsyncRawSource([[cell('b')]], () => modified_gate.promise);
        const source = new CompareDataSource(modified, original);
        let first_cancelled = false;

        const first = source.diff_rows(0, [0], () => first_cancelled);
        const second = source.diff_rows(0, [0]);
        const first_rejection = expect(first).rejects.toMatchObject({ name: 'AbortError' });
        await vi.waitFor(() => {
            expect(original.rawReads).toHaveLength(1);
            expect(modified.rawReads).toHaveLength(1);
        });
        const operation = (source as unknown as {
            diff_in_flight: Map<string, { waiters: Set<unknown> }>;
        }).diff_in_flight.get('0:0')!;
        expect(operation.waiters.size).toBe(2);

        first_cancelled = true;
        expect(original.rawReads[0].isCancelled()).toBe(false);
        expect(operation.waiters.size).toBe(1);
        await first_rejection;
        expect(modified.rawReads[0].isCancelled()).toBe(false);

        original_gate.resolve({ startRow: 0, rows: [[{ raw: 'a' }]] });
        modified_gate.resolve({ startRow: 0, rows: [[{ raw: 'b' }]] });
        await expect(second).resolves.toMatchObject({
            changedCells: [{ row: 0, col: 0, base: 'a', formattedBase: 'a' }],
        });
    });

    it('does not retain cancelled generations behind one live diff waiter', async () => {
        const original_gate = deferred<RawColumnWindow>();
        const modified_gate = deferred<RawColumnWindow>();
        const original = new AsyncRawSource([[cell('a')]], () => original_gate.promise);
        const modified = new AsyncRawSource([[cell('b')]], () => modified_gate.promise);
        const source = new CompareDataSource(modified, original);
        const live = source.diff_rows(0, [0]);

        await vi.waitFor(() => {
            expect(original.rawReads).toHaveLength(1);
            expect(modified.rawReads).toHaveLength(1);
        });
        const operation = (source as unknown as {
            diff_in_flight: Map<string, { waiters: Set<unknown> }>;
        }).diff_in_flight.get('0:0')!;

        for (let generation = 0; generation < 10; generation++) {
            let cancelled = false;
            const stale = source.diff_rows(0, [0], () => cancelled);
            const rejection = expect(stale).rejects.toMatchObject({ name: 'AbortError' });
            expect(operation.waiters.size).toBe(2);
            cancelled = true;
            expect(original.rawReads[0].isCancelled()).toBe(false);
            expect(operation.waiters.size).toBe(1);
            await rejection;
        }

        expect(original.rawReads).toHaveLength(1);
        expect(modified.rawReads).toHaveLength(1);
        original_gate.resolve({ startRow: 0, rows: [[{ raw: 'a' }]] });
        modified_gate.resolve({ startRow: 0, rows: [[{ raw: 'b' }]] });
        await expect(live).resolves.toMatchObject({
            changedCells: [{ row: 0, col: 0, base: 'a', formattedBase: 'a' }],
        });
    });

    it('does not attach a fresh waiter to work already committed to cancellation', async () => {
        const original_gates = [deferred<RawColumnWindow>(), deferred<RawColumnWindow>()];
        const modified_gates = [deferred<RawColumnWindow>(), deferred<RawColumnWindow>()];
        let original_read = 0;
        let modified_read = 0;
        const original = new AsyncRawSource(
            [[cell('a')]],
            () => original_gates[original_read++].promise,
        );
        const modified = new AsyncRawSource(
            [[cell('b')]],
            () => modified_gates[modified_read++].promise,
        );
        const source = new CompareDataSource(modified, original);
        let cancelled = false;

        const abandoned = source.diff_rows(0, [0], () => cancelled);
        const abandoned_rejection = expect(abandoned)
            .rejects.toMatchObject({ name: 'AbortError' });
        await vi.waitFor(() => {
            expect(original.rawReads).toHaveLength(1);
            expect(modified.rawReads).toHaveLength(1);
        });
        const abandoned_operation = (source as unknown as {
            diff_in_flight: Map<string, {
                waiters: Set<unknown>;
                terminal: boolean;
                cancelled: boolean;
                promise?: Promise<unknown>;
            }>;
        }).diff_in_flight.get('0:0')!;
        cancelled = true;
        // Model one side observing cancellation while its sibling remains pending.
        expect(original.rawReads[0].isCancelled()).toBe(true);
        expect(abandoned_operation.waiters.size).toBe(0);
        expect(abandoned_operation).toMatchObject({ terminal: true, cancelled: true });
        await abandoned_rejection;

        const fresh = source.diff_rows(0, [0]);
        await vi.waitFor(() => {
            expect(original.rawReads).toHaveLength(2);
            expect(modified.rawReads).toHaveLength(2);
        });
        original_gates[1].resolve({ startRow: 0, rows: [[{ raw: 'a' }]] });
        modified_gates[1].resolve({ startRow: 0, rows: [[{ raw: 'b' }]] });
        await expect(fresh).resolves.toMatchObject({
            changedCells: [{ row: 0, col: 0, base: 'a', formattedBase: 'a' }],
        });

        original_gates[0].reject(abort_error());
        modified_gates[0].reject(abort_error());
        await expect(abandoned_operation.promise).rejects.toMatchObject({ name: 'AbortError' });
    });

    it('awaits native rendered formatting without a synchronous reread', async () => {
        const rendered_gate = deferred<IndexedRows>();
        const original_cell: RenderedCell = {
            raw: '1',
            formatted: 'One',
            bold: false,
            italic: false,
            rawType: 'number',
        };
        const original = new AsyncRenderedSource(
            [[original_cell]],
            () => rendered_gate.promise,
        );
        const modified = new AsyncRawSource([[cell('2')]]);
        const source = new CompareDataSource(modified, original);

        const pending = source.diff_rows(0, [0]);
        let settled = false;
        void pending.finally(() => { settled = true; }).catch(() => {});
        await vi.waitFor(() => expect(original.indexedRenderedReads).toHaveLength(1));
        expect(settled).toBe(false);
        expect(original.indexedRenderedReads[0].rows).toEqual([0]);
        expect(original.renderedReads).toEqual([]);

        rendered_gate.resolve({ rows: [[original_cell]] });
        await expect(pending).resolves.toMatchObject({
            changedCells: [{ row: 0, col: 0, base: '1', formattedBase: 'One' }],
        });
        expect(original.renderedReads).toEqual([]);
    });

    it('fences close during native rendered formatting', async () => {
        const rendered_gate = deferred<IndexedRows>();
        const original_cell = cell('before');
        const original = new AsyncRenderedSource(
            [[original_cell]],
            () => rendered_gate.promise,
        );
        const modified = new AsyncRawSource([[cell('after')]]);
        const source = new CompareDataSource(modified, original);

        const pending = source.diff_rows(0, [0]);
        await vi.waitFor(() => expect(original.indexedRenderedReads).toHaveLength(1));
        source.close();
        expect(original.indexedRenderedReads[0].isCancelled()).toBe(true);
        rendered_gate.resolve({ rows: [[original_cell]] });

        await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
        expect((source as unknown as { diff_cache: Map<string, unknown> }).diff_cache.size)
            .toBe(0);
        expect(original.renderedReads).toEqual([]);
    });

    it('aborts in-flight work on close without resurrecting the completed cache', async () => {
        const original_gate = deferred<RawColumnWindow>();
        const modified_gate = deferred<RawColumnWindow>();
        const original = new AsyncRawSource([[cell('a')]], () => original_gate.promise);
        const modified = new AsyncRawSource([[cell('b')]], () => modified_gate.promise);
        const source = new CompareDataSource(modified, original);

        const pending = source.diff_rows(0, [0]);
        const rejection = expect(pending).rejects.toMatchObject({ name: 'AbortError' });
        await vi.waitFor(() => {
            expect(original.rawReads).toHaveLength(1);
            expect(modified.rawReads).toHaveLength(1);
        });
        const operation = (source as unknown as {
            diff_in_flight: Map<string, {
                waiters: Set<unknown>;
                terminal: boolean;
                cancelled: boolean;
                promise?: Promise<unknown>;
            }>;
        }).diff_in_flight.get('0:0')!;
        source.close();
        expect(original.rawReads[0].isCancelled()).toBe(true);
        expect(modified.rawReads[0].isCancelled()).toBe(true);
        expect(operation.waiters.size).toBe(0);
        expect(operation).toMatchObject({ terminal: true, cancelled: true });
        await rejection;

        original_gate.resolve({ startRow: 0, rows: [[{ raw: 'a' }]] });
        modified_gate.resolve({ startRow: 0, rows: [[{ raw: 'b' }]] });
        await expect(operation.promise).rejects.toMatchObject({ name: 'AbortError' });
        expect((source as unknown as { diff_cache: Map<string, unknown> }).diff_cache.size)
            .toBe(0);
        await expect(source.diff_rows(0, [0]))
            .rejects.toMatchObject({ name: 'AbortError' });
        expect(original.closed).toBe(true);
        expect(modified.closed).toBe(true);
    });

    it('maps padded rows to canonical rows appended after the modified side', () => {
        const source = compare([['a'], ['b'], ['c']], [['a']]);
        // Grid rows 1-2 are the deleted band; modified has 1 source row.
        expect([...source.source_row_indices(0, [0, 1, 2])]).toEqual([0, 1, 2]);
        expect(source.projected_row_index(0, 1)).toBe(1);
        expect(source.projected_row_index(0, 5)).toBeUndefined();
    });

    it('forwards the modified side row mapping for real rows', () => {
        const modified = new FixtureSource([{ name: 'Sheet1', rows: [['a'], ['b']] }]);
        const modified_meta = modified.meta();
        (modified as DataSource).meta = () => ({
            ...modified_meta,
            sheets: [{ ...modified_meta.sheets[0], sourceRowCount: 3 }],
        });
        (modified as DataSource).source_row_indices = (_sheet, rows) =>
            Uint32Array.from(rows as number[], (row) => row + 1);
        (modified as DataSource).projected_row_index = (_sheet, source_row) =>
            source_row - 1;
        const source = new CompareDataSource(
            modified,
            new FixtureSource([{ name: 'Sheet1', rows: [['a']] }]),
        );
        expect([...source.source_row_indices(0, [0, 1])]).toEqual([1, 2]);
        expect(source.projected_row_index(0, 1)).toBe(0);
    });

    it('rejects a short modified-side row mapping before it can coerce to row zero', () => {
        const modified = new FixtureSource([{ name: 'Sheet1', rows: [['a'], ['b']] }]);
        (modified as DataSource).source_row_indices = () => Uint32Array.of(1);
        const source = new CompareDataSource(
            modified,
            new FixtureSource([{ name: 'Sheet1', rows: [['a'], ['b']] }]),
        );

        expect(() => source.source_row_indices(0, [0, 1]))
            .toThrow('source row mapping length does not match projected rows');
    });

    it('surfaces original-side truncation and warnings beside the modified side', () => {
        const modified = new FixtureSource([{ name: 'Sheet1', rows: [['a']] }]);
        const original = new FixtureSource([{ name: 'Sheet1', rows: [['a']] }]);
        (modified as { truncationMessage?: string }).truncationMessage = 'mod cut';
        (original as { truncationMessage?: string }).truncationMessage = 'orig cut';
        (modified as { warnings?: string[] }).warnings = ['mod warn'];
        (original as { warnings?: string[] }).warnings = ['orig warn'];
        const source = new CompareDataSource(modified, original);
        expect(source.truncationMessage).toBe('mod cut (git original: orig cut)');
        expect(source.warnings).toEqual(['mod warn', 'Git original: orig warn']);
    });

    it('prefixes an original-only truncation message', () => {
        const modified = new FixtureSource([{ name: 'Sheet1', rows: [['a']] }]);
        const original = new FixtureSource([{ name: 'Sheet1', rows: [['a']] }]);
        (original as { truncationMessage?: string }).truncationMessage = 'orig cut';
        const source = new CompareDataSource(modified, original);
        expect(source.truncationMessage).toBe('Git original: orig cut');
        expect(source.warnings).toBeUndefined();
    });

    it('clamps read windows to the padded row count', () => {
        const source = compare([['a'], ['b']], [['a']]);
        const window = source.read_rows(0, 1, 10);
        expect(window.startRow).toBe(1);
        expect(window.rows).toHaveLength(1);
        expect(window.rows[0][0]?.raw).toBe('b');
        expect(source.read_rows(0, 5, 10).rows).toEqual([]);
    });
});

describe('CompareDataSource with a content alignment', () => {
    /** Build a compare source over an aligned pair, the way a host does. */
    const aligned = async (
        original_rows: string[][],
        modified_rows: string[][],
    ): Promise<CompareDataSource> => {
        const modified = new FixtureSource([{ name: 'Sheet1', rows: modified_rows }]);
        const original = new FixtureSource([{ name: 'Sheet1', rows: original_rows }]);
        return new CompareDataSource(
            modified,
            original,
            await align_workbook(modified, original),
        );
    };

    it('uses a supplied alignment to skip paired rows proven unchanged', async () => {
        const labeled = (raw: string, formatted: string): RenderedCell => ({
            raw,
            formatted,
            bold: false,
            italic: false,
            rawType: 'number',
        });
        const original = new AsyncRawSource([
            [labeled('1', 'Yes')],
            [labeled('2', 'No')],
        ]);
        const modified = new AsyncRawSource([
            [labeled('1', 'Yes')],
            [labeled('3', 'Maybe')],
        ]);
        const source = new CompareDataSource(
            modified,
            original,
            new Map([[0, positional_alignment([1], 2)]]),
        );

        expect(await source.diff_rows(0, [0, 1])).toMatchObject({
            rowStatus: ['same', 'same'],
            changedCells: [{ row: 1, col: 0, base: '2', formattedBase: 'No' }],
        });
        expect(original.rawReads).toEqual([
            expect.objectContaining({ startRow: 1, count: 1 }),
        ]);
        expect(modified.rawReads).toEqual([
            expect.objectContaining({ startRow: 1, count: 1 }),
        ]);
        expect(original.renderedReads).toEqual([{ startRow: 1, count: 1 }]);
        expect(modified.renderedReads).toEqual([]);
    });

    it('still compares fallback-aligned rows whose synthetic changed set is empty', async () => {
        const original = new AsyncRawSource([[cell('before')]]);
        const modified = new AsyncRawSource([[cell('after')]]);
        const source = new CompareDataSource(modified, original);

        expect((await source.diff_rows(0, [0]))?.changedCells).toEqual([
            { row: 0, col: 0, base: 'before', formattedBase: 'before' },
        ]);
        expect(original.rawReads).toEqual([
            expect.objectContaining({ startRow: 0, count: 1 }),
        ]);
        expect(modified.rawReads).toEqual([
            expect.objectContaining({ startRow: 0, count: 1 }),
        ]);
    });

    it('moves merges into unified-grid row space', async () => {
        // The unified grid interleaves the deleted row above the merge, so a
        // block anchored at modified rows 1-2 renders at 2-3. Left unprojected
        // it covered whatever sat at its old numbers.
        const modified = new FixtureSource([{
            name: 'Sheet1',
            rows: [['a'], ['b'], ['c']],
            merges: [{ startRow: 1, endRow: 2, startCol: 0, endCol: 0 }],
        }]);
        const original = new FixtureSource([{
            name: 'Sheet1',
            rows: [['GONE'], ['a'], ['b'], ['c']],
        }]);
        const source = new CompareDataSource(
            modified, original, await align_workbook(modified, original));
        expect(source.meta().sheets[0].merges)
            .toEqual([{ startRow: 2, endRow: 3, startCol: 0, endCol: 0 }]);
    });

    it('drops a merge an interleaved deletion splits apart', async () => {
        // Stretching it over the gap would swallow a deleted row into a block
        // that never contained it, which reads as a data change, not a layout
        // one.
        const modified = new FixtureSource([{
            name: 'Sheet1',
            rows: [['a'], ['b']],
            merges: [{ startRow: 0, endRow: 1, startCol: 0, endCol: 0 }],
        }]);
        const original = new FixtureSource([{
            name: 'Sheet1',
            rows: [['a'], ['GONE'], ['b']],
        }]);
        const source = new CompareDataSource(
            modified, original, await align_workbook(modified, original));
        expect(source.meta().sheets[0].merges).toEqual([]);
    });

    it('reports formatting when only the original side has it', async () => {
        // Deleted rows are served from the original, so their cells can be
        // formatted even when the modified file carries none; a consumer told
        // the comparison has no formatting would never ask for it.
        const modified = new FixtureSource([{ name: 'Sheet1', rows: [['a']] }]);
        const original = new FixtureSource([{
            name: 'Sheet1',
            rows: [['GONE'], ['a']],
            hasFormatting: true,
        }]);
        const source = new CompareDataSource(
            modified, original, await align_workbook(modified, original));
        expect(source.meta().hasFormatting).toBe(true);
        expect(source.meta().sheets[0].hasFormatting).toBe(true);
    });

    it('reports an inserted row as one addition, not a cascade of changed cells', async () => {
        // The regression this whole mechanism exists for: positionally, rows
        // 1..3 all differ, and the grid used to say so.
        const source = await aligned(
            [['a'], ['b'], ['c']],
            [['a'], ['NEW'], ['b'], ['c']],
        );
        expect(source.meta().sheets[0].rowCount).toBe(4);
        const diff = await diff_page(source, 0, 10);
        expect(diff?.rowStatus).toEqual(['same', 'added', 'same', 'same']);
        expect(diff?.changedCells).toEqual([]);
    });

    it('interleaves a deleted row where it was removed, carrying its content', async () => {
        const source = await aligned(
            [['a'], ['GONE'], ['b']],
            [['a'], ['b']],
        );
        const window = source.read_rows(0, 0, 10);
        expect(window.rows.map((row) => row[0]?.raw)).toEqual(['a', 'GONE', 'b']);
        expect((await diff_page(source, 0, 10))?.rowStatus)
            .toEqual(['same', 'deleted', 'same']);
    });

    it('still reports a genuine in-place edit as a changed cell', async () => {
        const source = await aligned([['a', 'x']], [['a', 'y']]);
        const diff = await diff_page(source, 0, 10);
        expect(diff?.rowStatus).toEqual(['same']);
        expect(diff?.changedCells).toEqual([
            { row: 0, col: 1, base: 'x', formattedBase: 'x' },
        ]);
    });

    it('lists added, deleted and changed rows for the changed-rows filter', async () => {
        const source = await aligned(
            [['a'], ['b'], ['c'], ['d']],
            [['a'], ['CHANGED'], ['c'], ['d'], ['NEW']],
        );
        expect(source.changed_grid_rows(0)).toEqual([1, 4]);
    });

    it('reports a moved row status, with its edits, end to end', async () => {
        const source = await aligned(
            [['Al', 'Eng', '10'], ['Bo', 'Ops', '20'], ['Cy', 'Fin', '30']],
            [['Al', 'Eng', '10'], ['Cy', 'Fin', '30'], ['Bo', 'Ops', '99']],
        );
        const diff = await diff_page(source, 0, 10);
        // Only Bo is 'moved'. Cy also shifted up a row, but Myers paired it as
        // part of the longest common subsequence, so it was never one-sided and
        // never reached the move pass. 'moved' means "re-paired across a move",
        // not "sits at a different row number" — which is the right meaning:
        // marking every row below an insertion point as moved would be noise.
        expect(diff?.rowStatus).toEqual(['same', 'same', 'moved']);
        // The moved row is still diffed cell by cell, which is the whole point:
        // its edit is reported as an edit rather than left to the eye.
        expect(diff?.changedCells).toEqual([
            { row: 2, col: 2, base: '20', formattedBase: '20' },
        ]);
        // The summary has to agree with the banding. Asserted here because
        // every other movedRows assertion in the suite is either zero or a
        // hand-supplied prop, so a count that never left the aligner would go
        // unnoticed and a move-only comparison would read as no differences.
        expect(source.change_counts()).toMatchObject({
            movedRows: 1, addedRows: 0, deletedRows: 0,
        });
    });

    it('reports when a sheet had too many rows to check them all for moves', async () => {
        // The moved row is also edited, so it needs a similarity score rather
        // than an exact hash match — the only phase the cap gates.
        const modified = new FixtureSource([
            { name: 'S', rows: [['keep'], ['y'], ['Bo', 'Ops', '99']] },
        ]);
        const original = new FixtureSource([
            { name: 'S', rows: [['Bo', 'Ops', '20'], ['keep'], ['y']] },
        ]);
        const relaxed = new CompareDataSource(
            modified, original, await align_workbook(modified, original));
        expect(relaxed.moveSearchTruncated).toBe(false);
        const capped = new CompareDataSource(
            modified,
            original,
            await align_workbook(modified, original, { maxMoveSearchRows: 0 }),
        );
        expect(capped.moveSearchTruncated).toBe(true);
    });

    it('keeps a purely moved row under the changed-rows filter', async () => {
        // It is neither one-sided nor in changedRowIndices, so it would vanish
        // from the one view a user hunting changes would most expect it in.
        const source = await aligned(
            [['a'], ['b'], ['c'], ['d']],
            [['b'], ['c'], ['d'], ['a']],
        );
        expect(source.changed_grid_rows(0)).toEqual([3]);
    });

    it('uses an uncached all-rows sentinel for one-sided sheets', async () => {
        const modified = new FixtureSource([{ name: 'Fresh', rows: [['x'], ['y']] }]);
        const original = new FixtureSource([{ name: 'Gone', rows: [['z']] }]);
        const source = new CompareDataSource(
            modified, original, await align_workbook(modified, original));
        const cache = (source as unknown as {
            changed_grid_rows_cache: Map<number, readonly number[]>;
        }).changed_grid_rows_cache;

        expect(source.changed_grid_rows(0)).toBeUndefined();
        expect(source.changed_grid_rows(1)).toBeUndefined();
        expect(cache.size).toBe(0);
    });

    it('keeps deleted-row indexes lazy and uses the stored deletion count', () => {
        const modified = new FixtureSource([{ name: 'S', rows: [] }]);
        const original = new FixtureSource([{ name: 'S', rows: [['gone']] }]);
        const rows = [{ original: 0, modified: ABSENT }];
        const filter = vi.spyOn(rows, 'filter');
        const alignment: SheetAlignment = {
            rows,
            addedRows: 0,
            deletedRows: 1,
            changedCells: 0,
            changedRowIndices: [],
            movedRowIndices: [],
            moveSearchTruncated: false,
            degraded: false,
        };
        const source = new CompareDataSource(
            modified,
            original,
            new Map([[0, alignment]]),
        );
        const deleted = (source as unknown as {
            deleted_grid_rows: Map<number, Uint32Array>;
        }).deleted_grid_rows;

        expect(source.meta().sheets[0].sourceRowCount).toBe(1);
        expect(filter).not.toHaveBeenCalled();
        expect(deleted.size).toBe(0);
        expect([...source.source_row_indices(0, [0])]).toEqual([0]);
        expect(deleted.size).toBe(1);
    });

    it('shares one byte-bounded LRU across derived row indexes', async () => {
        const modified = new FixtureSource([
            { name: 'A', rows: [['keep']] },
            { name: 'B', rows: [['keep']] },
        ]);
        const original = new FixtureSource([
            { name: 'A', rows: [['gone'], ['keep']] },
            { name: 'B', rows: [['gone'], ['keep']] },
        ]);
        const source = new CompareDataSource(
            modified,
            original,
            await align_workbook(modified, original),
            16 * 1024 * 1024,
            130,
        );
        const internals = source as unknown as {
            deleted_grid_rows: Map<number, Uint32Array>;
            grid_row_by_modified_cache: Map<number, Uint32Array>;
            changed_grid_rows_cache: Map<number, readonly number[]>;
            derived_row_index_lru: Map<number, unknown>;
            derived_row_index_cache_bytes: number;
        };

        expect(source.projected_row_index(0, 0)).toBe(1);
        expect(internals.grid_row_by_modified_cache.has(0)).toBe(true);
        expect([...source.source_row_indices(1, [0, 1])]).toEqual([1, 0]);
        expect(internals.grid_row_by_modified_cache.size).toBe(0);
        expect(internals.deleted_grid_rows.has(1)).toBe(true);
        expect(source.changed_grid_rows(0)).toEqual([0]);
        expect(internals.deleted_grid_rows.size).toBe(0);
        expect(internals.changed_grid_rows_cache.has(0)).toBe(true);
        expect(internals.derived_row_index_lru.size).toBe(1);
        expect(internals.derived_row_index_cache_bytes).toBeLessThanOrEqual(130);
    });

    it('returns oversized changed-row indexes without retaining them', async () => {
        const modified = new FixtureSource([{ name: 'S', rows: [['keep']] }]);
        const original = new FixtureSource([{ name: 'S', rows: [['gone'], ['keep']] }]);
        const source = new CompareDataSource(
            modified,
            original,
            await align_workbook(modified, original),
            16 * 1024 * 1024,
            127,
        );
        const cache = (source as unknown as {
            changed_grid_rows_cache: Map<number, readonly number[]>;
        }).changed_grid_rows_cache;

        expect(source.changed_grid_rows(0)).toEqual([0]);
        expect(cache.size).toBe(0);
        expect(source.changed_grid_rows(0)).toEqual([0]);
        expect(cache.size).toBe(0);
    });

    it('totals changes across sheets, counting one-sided sheets whole', async () => {
        const modified = new FixtureSource([
            { name: 'Kept', rows: [['a'], ['CHANGED'], ['NEW']] },
            { name: 'Fresh', rows: [['x'], ['y']] },
        ]);
        const original = new FixtureSource([{ name: 'Kept', rows: [['a'], ['b']] }]);
        const source = new CompareDataSource(
            modified, original, await align_workbook(modified, original));
        expect(source.change_counts()).toEqual({
            addedRows: 3,      // one row in Kept, two from the whole Fresh sheet
            deletedRows: 0,
            movedRows: 0,
            changedCells: 1,
        });
    });

    it('maps a deleted row to a canonical row past the modified side', async () => {
        const source = await aligned([['a'], ['GONE'], ['b']], [['a'], ['b']]);
        // Grid rows 0 and 2 are the modified side's rows 0 and 1; grid row 1 is
        // the deleted one, which takes the next canonical number.
        expect([...source.source_row_indices(0, [0, 1, 2])]).toEqual([0, 2, 1]);
        expect(source.projected_row_index(0, 2)).toBe(1);
        expect(source.projected_row_index(0, 0)).toBe(0);
        expect(source.projected_row_index(0, 1)).toBe(2);
        const inverse = (source as unknown as {
            grid_row_by_modified_cache: Map<number, Uint32Array>;
        }).grid_row_by_modified_cache.get(0);
        expect(inverse).toBeInstanceOf(Uint32Array);
        expect([...inverse!]).toEqual([0, 2]);
    });

    it('derives interleaved deleted canonical rows from their grid rank', async () => {
        const source = await aligned(
            [['a'], ['GONE-1'], ['b'], ['GONE-2'], ['c']],
            [['a'], ['b'], ['c']],
        );

        expect([...source.source_row_indices(0, [0, 1, 2, 3, 4])])
            .toEqual([0, 3, 1, 4, 2]);
        expect(source.projected_row_index(0, 3)).toBe(1);
        expect(source.projected_row_index(0, 4)).toBe(3);
    });

    it('round-trips every grid row through source_row_indices', async () => {
        const source = await aligned(
            [['a'], ['x'], ['b'], ['y'], ['c']],
            [['a'], ['b'], ['NEW'], ['c']],
        );
        const grid_rows = Array.from(
            { length: source.meta().sheets[0].rowCount }, (_, row) => row);
        const canonical = source.source_row_indices(0, grid_rows);
        // A distinct canonical row per grid row, each mapping back to itself.
        expect(new Set(canonical).size).toBe(grid_rows.length);
        grid_rows.forEach((grid_row, index) => {
            expect(source.projected_row_index(0, canonical[index])).toBe(grid_row);
        });
    });

    it('releases derived row-index caches on close', async () => {
        const source = await aligned(
            [['a'], ['GONE'], ['b']],
            [['a'], ['CHANGED']],
        );
        source.projected_row_index(0, 0);
        source.source_row_indices(0, [0, 1, 2]);
        source.changed_grid_rows(0);
        const internals = source as unknown as {
            alignments: Map<number, SheetAlignment>;
            deleted_grid_rows: Map<number, Uint32Array>;
            grid_row_by_modified_cache: Map<number, Uint32Array>;
            changed_grid_rows_cache: Map<number, readonly number[]>;
            derived_row_index_lru: Map<number, unknown>;
            derived_row_index_cache_bytes: number;
        };
        expect(internals.alignments.size).toBe(1);
        expect(internals.deleted_grid_rows.size).toBe(1);
        expect(internals.grid_row_by_modified_cache.size).toBe(1);
        expect(internals.changed_grid_rows_cache.size).toBe(1);
        expect(internals.derived_row_index_lru.size).toBe(3);
        expect(internals.derived_row_index_cache_bytes).toBeGreaterThan(0);

        source.close();

        expect(internals.alignments.size).toBe(0);
        expect(internals.deleted_grid_rows.size).toBe(0);
        expect(internals.grid_row_by_modified_cache.size).toBe(0);
        expect(internals.changed_grid_rows_cache.size).toBe(0);
        expect(internals.derived_row_index_lru.size).toBe(0);
        expect(internals.derived_row_index_cache_bytes).toBe(0);
    });

    it('flags a degraded alignment so the host can say the rows did not match', async () => {
        const modified = new FixtureSource([{ name: 'S', rows: [['p'], ['q'], ['r']] }]);
        const original = new FixtureSource([{ name: 'S', rows: [['x'], ['y'], ['z']] }]);
        const source = new CompareDataSource(
            modified, original,
            await align_workbook(modified, original, { maxEditDistance: 1 }),
        );
        expect(source.degraded).toBe(true);
        // Positional fallback: three rows, all changed, none added or deleted.
        expect((await diff_page(source, 0, 10))?.rowStatus)
            .toEqual(['same', 'same', 'same']);
    });
    it('withholds the first-row-header capability from every grid sheet', async () => {
        // The wrapper is deliberately not an ExcelHeaderDataSource, so the
        // controller refuses every header command it is sent. Reporting the
        // capability anyway put a live Header Row button in front of the user
        // whose only outcome was the refusal dialog — and a pending header
        // request blocks transforms and column visibility until it settles, so
        // the refusal stalled whatever they tried next.
        const header = {
            mode: 'auto', detected: true, active: true, available: true, sourceRow: 0,
        } as const;
        const modified = new FixtureSource([
            { name: 'S', excelFirstRowHeader: header, rows: [['a'], ['b']] },
            { name: 'Added', excelFirstRowHeader: header, rows: [['n']] },
        ]);
        const original = new FixtureSource([
            { name: 'S', excelFirstRowHeader: header, rows: [['a'], ['b']] },
            { name: 'Gone', excelFirstRowHeader: header, rows: [['g']] },
        ]);
        const source = new CompareDataSource(
            modified, original, await align_workbook(modified, original),
        );
        // Matched, added and deleted sheets alike.
        expect(source.meta().sheets).toHaveLength(3);
        for (const sheet of source.meta().sheets) {
            expect(sheet.excelFirstRowHeader).toBeUndefined();
        }
    });
});
