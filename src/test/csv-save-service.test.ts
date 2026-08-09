import { describe, expect, it, vi } from 'vitest';
import type { DataSource, WorkbookMeta } from '../data-source/interface';
import type { FileStat, FileSystemPort } from '../host-ports';
import type { ResourceUriLike } from '../resource-identity';
import {
    CsvSaveServiceError,
    csv_content_digest,
    prepare_csv_save_content,
    read_csv_target_stably,
    write_csv_target,
    type CsvCancellation,
} from '../csv-save-service';
import type { CsvDirtyEntry } from '../types';

const encoder = new TextEncoder();
const decoder = new TextDecoder();

const resource: ResourceUriLike = {
    scheme: 'mem',
    authority: 'tests',
    path: '/table.csv',
    query: '',
    fragment: '',
    fsPath: '/table.csv',
};

class RowsSource implements DataSource {
    readonly originalColumnCounts: number[];
    readCalls = 0;
    readonly lineEnding: '\r\n' | '\r' | '\n';
    readonly headerLine?: string;
    truncationMessage?: string;

    constructor(
        private readonly rows: readonly (readonly string[])[],
        options: {
            readonly lineEnding?: '\r\n' | '\r' | '\n';
            readonly headerLine?: string;
            readonly truncated?: boolean;
        } = {},
    ) {
        this.originalColumnCounts = rows.map((row) => row.length);
        this.lineEnding = options.lineEnding ?? '\n';
        this.headerLine = options.headerLine;
        if (options.truncated) this.truncationMessage = 'truncated';
    }

    meta(): WorkbookMeta {
        return {
            hasFormatting: false,
            sheets: [{
                name: 'Sheet1',
                rowCount: this.rows.length,
                sourceRowCount: this.rows.length,
                columnCount: Math.max(0, ...this.rows.map((row) => row.length)),
                merges: [],
                hasFormatting: false,
            }],
        };
    }

    read_rows(_sheet: number, start: number, count: number) {
        this.readCalls += 1;
        return {
            startRow: start,
            rows: this.rows.slice(start, start + count).map((row) => row.map((raw) => ({
                raw,
                formatted: raw,
                bold: false,
                italic: false,
                rawType: 'string' as const,
            }))),
        };
    }

    close(): void {}
}

class MemoryFileSystem implements FileSystemPort {
    bytes: Uint8Array;
    mtime = 1;
    statCalls = 0;
    readCalls = 0;
    writeCalls = 0;
    onStat?: (call: number, stat: FileStat) => FileStat;
    onWrite?: (content: Uint8Array) => void | Promise<void>;
    writeFailure?: Error;

    constructor(text: string) {
        this.bytes = encoder.encode(text);
    }

    async stat(): Promise<FileStat> {
        this.statCalls += 1;
        const stat = { size: this.bytes.byteLength, mtime: this.mtime };
        return this.onStat?.(this.statCalls, stat) ?? stat;
    }

    async read_file(): Promise<Uint8Array> {
        this.readCalls += 1;
        return Uint8Array.from(this.bytes);
    }

    async write_file(_resource: ResourceUriLike, content: Uint8Array): Promise<void> {
        this.writeCalls += 1;
        if (this.writeFailure) throw this.writeFailure;
        this.bytes = Uint8Array.from(content);
        this.mtime += 1;
        await this.onWrite?.(content);
    }
}

function dirty(entries: Record<string, CsvDirtyEntry>): ReadonlyMap<string, CsvDirtyEntry> {
    return new Map(Object.entries(entries));
}

function prepared(text: string) {
    const bytes = encoder.encode(text);
    return { type: 'prepared' as const, bytes, digest: csv_content_digest(bytes) };
}

function basis(fs: MemoryFileSystem) {
    return {
        stat: { size: fs.bytes.byteLength, mtime: fs.mtime },
        digest: csv_content_digest(fs.bytes),
    };
}

describe('CSV save preparation', () => {
    it('validates dirty bases and preserves CSV metadata while serializing windows', () => {
        const source = new RowsSource([['a', 'b'], ['c']], {
            lineEnding: '\r\n',
            headerLine: 'h1,h2',
        });
        const dirty_entries = dirty({
            '0:1': { value: 'B,2', base: 'b' },
            '1:1': { value: 'new', base: '' },
        });
        const result = prepare_csv_save_content({
            source,
            delimiter: ',',
            edits: new Map([...dirty_entries].map(([key, entry]) => [key, entry.value])),
            dirtyEntries: dirty_entries,
        });
        expect(result.type).toBe('prepared');
        if (result.type !== 'prepared') throw new Error('expected prepared content');
        expect(decoder.decode(result.bytes)).toBe('h1,h2\r\na,"B,2"\r\nc,new\r\n');
        expect(result.digest).toBe(csv_content_digest(result.bytes));
    });

    it('rejects truncation, removed rows, and stale bases explicitly', () => {
        expect(() => prepare_csv_save_content({
            source: new RowsSource([['a']], { truncated: true }),
            delimiter: ',', edits: new Map(), dirtyEntries: dirty({}),
        })).toThrowError(expect.objectContaining({ code: 'truncated' }));

        expect(prepare_csv_save_content({
            source: new RowsSource([['a']]), delimiter: ',',
            edits: new Map([['2:0', 'x']]),
            dirtyEntries: dirty({ '2:0': { value: 'x', base: 'a' } }),
        })).toEqual({
            type: 'rejected',
            rejection: { reason: 'rowsRemoved', keys: ['2:0'] },
        });

        expect(prepare_csv_save_content({
            source: new RowsSource([['a']]), delimiter: ',',
            edits: new Map([['0:0', 'x']]),
            dirtyEntries: dirty({ '0:0': { value: 'x', base: 'stale' } }),
        })).toEqual({
            type: 'rejected',
            rejection: { reason: 'baseMismatch', keys: ['0:0'] },
        });
    });

    it('keeps serialization edits independent from dirty-base validation entries', () => {
        const result = prepare_csv_save_content({
            source: new RowsSource([['a', 'b']]),
            delimiter: ',',
            edits: new Map([['0:1', 'serialized']]),
            dirtyEntries: dirty({ '0:0': { value: 'different', base: 'a' } }),
        });
        expect(result.type).toBe('prepared');
        if (result.type !== 'prepared') throw new Error('expected prepared content');
        expect(decoder.decode(result.bytes)).toBe('a,serialized\n');
    });

    it('harvests bases during the same bounded traversal used for serialization', () => {
        const source = new RowsSource(Array.from({ length: 10_001 }, () => ['a']));
        const result = prepare_csv_save_content({
            source,
            delimiter: ',',
            edits: new Map([['10000:0', 'z']]),
            dirtyEntries: dirty({ '10000:0': { value: 'z', base: 'a' } }),
        });
        expect(result.type).toBe('prepared');
        expect(source.readCalls).toBe(2);
    });
});

describe('CSV target reads and writes', () => {
    it('requires a stable stat/read/stat observation', async () => {
        const fs = new MemoryFileSystem('a\n');
        fs.onStat = (call, stat) => ({ ...stat, mtime: call });
        await expect(read_csv_target_stably(fs, resource, 100, undefined, 2))
            .rejects.toMatchObject({ code: 'unstableTarget' });
        expect(fs.readCalls).toBe(2);
    });

    it('rejects a full-digest external change even when size and mtime match', async () => {
        const fs = new MemoryFileSystem('b\n');
        const stale = {
            stat: { size: 2, mtime: 1 },
            digest: csv_content_digest(encoder.encode('a\n')),
        };
        await expect(write_csv_target({
            fs, resource, content: prepared('c\n'), maxFileSizeBytes: 100,
            expectedTarget: stale,
        })).rejects.toMatchObject({ code: 'externalChange' });
        expect(fs.writeCalls).toBe(0);
    });

    it('rejects a final-stat race before invoking write_file', async () => {
        const fs = new MemoryFileSystem('a\n');
        const expected = basis(fs);
        fs.onStat = (call, stat) => call === 3 ? { ...stat, mtime: 99 } : stat;
        await expect(write_csv_target({
            fs, resource, content: prepared('b\n'), maxFileSizeBytes: 100,
            expectedTarget: expected,
        })).rejects.toMatchObject({ code: 'externalChange' });
        expect(fs.writeCalls).toBe(0);
    });

    it('finishes verification after write starts, even when cancellation arrives late', async () => {
        const fs = new MemoryFileSystem('a\n');
        const expected = basis(fs);
        const cancellation = { isCancellationRequested: false } as { isCancellationRequested: boolean };
        fs.onWrite = () => { cancellation.isCancellationRequested = true; };
        const result = await write_csv_target({
            fs, resource, content: prepared('b\n'), maxFileSizeBytes: 100,
            expectedTarget: expected,
            cancellation: cancellation as CsvCancellation,
        });
        expect(result.digest).toBe(csv_content_digest(encoder.encode('b\n')));
        expect(decoder.decode(fs.bytes)).toBe('b\n');
        expect(fs.readCalls).toBe(2);
    });

    it('treats a rejected write as successful when verification proves it landed', async () => {
        const fs = new MemoryFileSystem('a\n');
        const expected = basis(fs);
        fs.onWrite = () => { throw new Error('late provider failure'); };
        const result = await write_csv_target({
            fs, resource, content: prepared('b\n'), maxFileSizeBytes: 100,
            expectedTarget: expected,
        });
        expect(result.digest).toBe(csv_content_digest(fs.bytes));
    });

    it('cancels watcher reservations and skips post-save refresh when a write fails', async () => {
        const fs = new MemoryFileSystem('a\n');
        fs.writeFailure = new Error('write failed');
        const reservation = { cancel: vi.fn() };
        const refresh = {
            reserve_post_save: vi.fn(() => reservation),
            request: vi.fn(async () => ({ type: 'completed' as const })),
        };
        await expect(write_csv_target({
            fs, resource, content: prepared('b\n'), maxFileSizeBytes: 100,
            expectedTarget: basis(fs), refresh,
        })).rejects.toMatchObject({ code: 'writeFailed' });
        expect(reservation.cancel).toHaveBeenCalledOnce();
        expect(refresh.request).not.toHaveBeenCalled();
    });

    it('cancels watcher reservations and skips post-save refresh on verification mismatch', async () => {
        const fs = new MemoryFileSystem('a\n');
        fs.onWrite = () => { fs.bytes = encoder.encode('c\n'); };
        const reservation = { cancel: vi.fn() };
        const refresh = {
            reserve_post_save: vi.fn(() => reservation),
            request: vi.fn(async () => ({ type: 'completed' as const })),
        };
        await expect(write_csv_target({
            fs, resource, content: prepared('b\n'), maxFileSizeBytes: 100,
            expectedTarget: basis(fs), refresh,
        })).rejects.toMatchObject({ code: 'verificationFailed' });
        expect(reservation.cancel).toHaveBeenCalledOnce();
        expect(refresh.request).not.toHaveBeenCalled();
    });

    it('rejects oversized prepared content before writing or reserving refresh', async () => {
        const fs = new MemoryFileSystem('a\n');
        const reserve = vi.fn(() => ({ cancel: vi.fn() }));
        await expect(write_csv_target({
            fs, resource, content: prepared('too large\n'), maxFileSizeBytes: 2,
            refresh: {
                reserve_post_save: reserve,
                request: vi.fn(async () => ({ type: 'completed' as const })),
            },
        })).rejects.toMatchObject({ code: 'tooLarge' });
        expect(fs.writeCalls).toBe(0);
        expect(reserve).not.toHaveBeenCalled();
    });

    it('Save As skips original comparison and reserves then requests post-save refresh', async () => {
        const fs = new MemoryFileSystem('destination\n');
        const reservation = { cancel: vi.fn() };
        const refresh = {
            reserve_post_save: vi.fn(() => reservation),
            request: vi.fn(async () => ({ type: 'completed' as const })),
        };
        await write_csv_target({
            fs, resource, content: prepared('saved-as\n'), maxFileSizeBytes: 100,
            refresh,
        });
        expect(fs.readCalls).toBe(1);
        expect(refresh.reserve_post_save).toHaveBeenCalledOnce();
        expect(refresh.request).toHaveBeenCalledWith('postSave');
        expect(reservation.cancel).not.toHaveBeenCalled();
    });

    it('does not delay a verified save on its post-save refresh subscriber', async () => {
        const fs = new MemoryFileSystem('a\n');
        const never = new Promise<never>(() => {});
        const result = await write_csv_target({
            fs, resource, content: prepared('b\n'), maxFileSizeBytes: 100,
            expectedTarget: basis(fs),
            refresh: {
                reserve_post_save: () => ({ cancel: vi.fn() }),
                request: vi.fn(() => never),
            },
        });
        expect(result.digest).toBe(csv_content_digest(encoder.encode('b\n')));
        expect(result.postSaveCompletion).toBeDefined();
    });

    it('honors cancellation before taking the post-save reservation', async () => {
        const fs = new MemoryFileSystem('a\n');
        const reserve = vi.fn(() => ({ cancel: vi.fn() }));
        let reads = 0;
        const cancellation = {
            get isCancellationRequested() {
                reads += 1;
                return reads >= 6;
            },
        };
        await expect(write_csv_target({
            fs, resource, content: prepared('b\n'), maxFileSizeBytes: 100,
            expectedTarget: basis(fs), cancellation,
            refresh: {
                reserve_post_save: reserve,
                request: vi.fn(async () => undefined),
            },
        })).rejects.toBeInstanceOf(CsvSaveServiceError);
        expect(fs.writeCalls).toBe(0);
        expect(reserve).not.toHaveBeenCalled();
    });
});
