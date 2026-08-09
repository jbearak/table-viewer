import { describe, expect, it, vi } from 'vitest';
import {
    CsvCustomDocument,
    MAX_SETTLEMENT_DRAIN_PASSES,
    type CsvDocumentEditEvent,
} from '../csv-custom-document';
import {
    CSV_DOCUMENT_BACKUP_V2_MAX_SOURCE_BYTES,
    encode_csv_document_backup,
} from '../csv-document-backup';
import { csv_content_digest } from '../csv-save-service';
import type { FileStat, FileSystemPort } from '../host-ports';
import { create_resource_identity, type ResourceUriLike } from '../resource-identity';

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function deferred<T = void>() {
    let resolve!: (value: T | PromiseLike<T>) => void;
    const promise = new Promise<T>((done) => { resolve = done; });
    return { promise, resolve };
}

function uri(path: string): ResourceUriLike {
    return {
        scheme: 'mem', authority: 'document-tests', path, query: '', fragment: '', fsPath: path,
    };
}

interface MemoryFile {
    bytes: Uint8Array;
    mtime: number;
}

class MemoryFileSystem implements FileSystemPort {
    readonly files = new Map<string, MemoryFile>();
    failNextRead?: Error;
    onWrite?: (resource: ResourceUriLike, content: Uint8Array) => void | Promise<void>;
    readonly statSpy = vi.fn();
    readonly readSpy = vi.fn();
    readonly writeSpy = vi.fn();

    set(path: string, text: string, options: { mtime?: number } = {}): void {
        this.files.set(path, { bytes: encoder.encode(text), mtime: options.mtime ?? 1 });
    }

    text(path: string): string {
        const file = this.files.get(path);
        if (!file) throw new Error(`missing ${path}`);
        return decoder.decode(file.bytes);
    }

    async stat(resource: ResourceUriLike): Promise<FileStat> {
        this.statSpy(resource);
        const file = this.files.get(resource.path);
        if (!file) throw Object.assign(new Error('not found'), { code: 'ENOENT' });
        return { size: file.bytes.byteLength, mtime: file.mtime };
    }

    async read_file(resource: ResourceUriLike): Promise<Uint8Array> {
        this.readSpy(resource);
        if (this.failNextRead) {
            const error = this.failNextRead;
            this.failNextRead = undefined;
            throw error;
        }
        const file = this.files.get(resource.path);
        if (!file) throw Object.assign(new Error('not found'), { code: 'ENOENT' });
        return Uint8Array.from(file.bytes);
    }

    async write_file(resource: ResourceUriLike, content: Uint8Array): Promise<void> {
        this.writeSpy(resource, content);
        const current = this.files.get(resource.path);
        this.files.set(resource.path, {
            bytes: Uint8Array.from(content),
            mtime: (current?.mtime ?? 0) + 1,
        });
        await this.onWrite?.(resource, content);
    }
}

const view_mutation_epochs = new WeakMap<CsvCustomDocument, Map<string, number>>();
const view_epoch_subscriptions = new WeakSet<CsvCustomDocument>();

function tracked_view_epochs(document: CsvCustomDocument): Map<string, number> {
    let epochs = view_mutation_epochs.get(document);
    if (!epochs) {
        epochs = new Map();
        view_mutation_epochs.set(document, epochs);
    }
    if (!view_epoch_subscriptions.has(document)) {
        view_epoch_subscriptions.add(document);
        document.on_did_request_resync((event) => {
            tracked_view_epochs(document).set(event.viewId, event.viewMutationEpoch);
        });
    }
    return epochs;
}

async function attach_test_view(
    document: CsvCustomDocument,
    view_id: string,
) {
    const result = await document.attach_view(view_id);
    tracked_view_epochs(document).set(view_id, result.viewMutationEpoch);
    return result;
}

async function resync_test_view(
    document: CsvCustomDocument,
    view_id: string,
    mutation_epoch?: number,
    view_mutation_epoch?: number,
) {
    const result = await document.resync_view(
        view_id,
        mutation_epoch,
        view_mutation_epoch,
    );
    tracked_view_epochs(document).set(view_id, result.viewMutationEpoch);
    return result;
}

function view_authority(document: CsvCustomDocument, view_id: string) {
    const viewMutationEpoch = tracked_view_epochs(document).get(view_id);
    if (viewMutationEpoch === undefined) throw new Error(`untracked view ${view_id}`);
    return { viewId: view_id, viewMutationEpoch };
}

async function open_document(
    fs: MemoryFileSystem,
    path = '/table.csv',
    options: { maxRows?: number } = {},
): Promise<CsvCustomDocument> {
    const document = await CsvCustomDocument.open({
        resource: uri(path),
        fs,
        maxFileSizeBytes: 1_024 * 1_024,
        maxRows: options.maxRows ?? 1_000,
    });
    expect(await attach_test_view(document, 'view-1')).toMatchObject({
        type: 'attached',
        viewMutationEpoch: expect.any(Number),
    });
    return document;
}

describe('CsvCustomDocument gestures and revisions', () => {
    it('applies live input immediately and emits an immutable native segment per content change', async () => {
        const fs = new MemoryFileSystem();
        fs.set('/table.csv', 'h1,h2\na,b\nc,d\n');
        const document = await open_document(fs);
        const edits: CsvDocumentEditEvent[] = [];
        const content: string[] = [];
        document.on_did_change((event) => edits.push(event));
        document.on_did_change_content((event) => {
            if (event.type === 'cell') content.push(`${event.key}=${event.value}`);
        });

        expect(await document.apply_cell_input({
            mutationEpoch: document.mutationEpoch,
            ...view_authority(document, 'view-1'), key: '0:0', value: 'A', revision: 0,
        })).toEqual({ type: 'accepted', revision: 1, sourceGeneration: 1, changed: true });
        expect(document.cell_value('0:0')).toBe('A');
        expect(document.dirty_entry('0:0')).toEqual({ value: 'A', base: 'a' });
        expect(edits).toHaveLength(1);
        expect(edits[0].beforeValue).toBe('a');
        expect(edits[0].afterValue).toBe('A');

        await document.apply_cell_input({
            mutationEpoch: document.mutationEpoch,
            ...view_authority(document, 'view-1'), key: '0:0', value: 'AA', revision: 1,
        });
        expect(edits).toHaveLength(2);
        expect(edits[0]).toMatchObject({ beforeValue: 'a', afterValue: 'A' });
        expect(edits[1]).toMatchObject({ beforeValue: 'A', afterValue: 'AA' });
        expect(document.dirty_entry('0:0')).toEqual({ value: 'AA', base: 'a' });
        expect(content).toEqual(['0:0=A', '0:0=AA']);

        await document.complete_gesture({ mutationEpoch: document.mutationEpoch, ...view_authority(document, 'view-1'), revision: 2 });
        await document.apply_cell_input({
            mutationEpoch: document.mutationEpoch,
            ...view_authority(document, 'view-1'), key: '1:1', value: 'D', revision: 2,
        });
        expect(edits).toHaveLength(3);
        await document.apply_cell_input({
            mutationEpoch: document.mutationEpoch,
            ...view_authority(document, 'view-1'), key: '0:0', value: 'AAA', revision: 3,
        });
        expect(edits).toHaveLength(4);
        await document.dispose();
    });

    it('acknowledges no-op live input with a contiguous revision and no edit event', async () => {
        const fs = new MemoryFileSystem();
        fs.set('/table.csv', 'h1\na\n');
        const document = await open_document(fs);
        const edits: CsvDocumentEditEvent[] = [];
        const content: Array<{ revision: number; value: string }> = [];
        document.on_did_change((event) => edits.push(event));
        document.on_did_change_content((event) => {
            if (event.type === 'cell') content.push({
                revision: event.revision,
                value: event.value,
            });
        });

        expect(await document.apply_cell_input({
            mutationEpoch: document.mutationEpoch,
            ...view_authority(document, 'view-1'), key: '0:0', value: 'a', revision: 0,
        })).toEqual({
            type: 'accepted', revision: 1, sourceGeneration: 1, changed: false,
        });
        expect(edits).toEqual([]);
        expect(content).toEqual([{ revision: 1, value: 'a' }]);
        expect(await document.complete_gesture({ mutationEpoch: document.mutationEpoch, ...view_authority(document, 'view-1'), revision: 1 }))
            .toMatchObject({ type: 'accepted', revision: 1 });

        await document.apply_cell_input({
            mutationEpoch: document.mutationEpoch,
            ...view_authority(document, 'view-1'), key: '0:0', value: 'A', revision: 1,
        });
        expect(edits).toHaveLength(1);
        await document.dispose();
    });

    it('unwinds every published segment when a gesture completes at its absolute start', async () => {
        const fs = new MemoryFileSystem();
        fs.set('/table.csv', 'h1\na\n');
        const document = await open_document(fs);
        const edits: CsvDocumentEditEvent[] = [];
        let native_cursor = 0;
        document.on_did_change((event) => {
            edits.splice(native_cursor);
            edits.push(event);
            native_cursor += 1;
        });

        await document.apply_cell_input({
            mutationEpoch: document.mutationEpoch,
            ...view_authority(document, 'view-1'), key: '0:0', value: 'live', revision: 0,
        });
        await document.apply_cell_input({
            mutationEpoch: document.mutationEpoch,
            ...view_authority(document, 'view-1'), key: '0:0', value: 'a', revision: 1,
        });
        expect(document.isDirty).toBe(false);
        expect(native_cursor).toBe(2);
        const native_history = vi.fn(async (direction: 'undo' | 'redo') => {
            expect(direction).toBe('undo');
            native_cursor -= 1;
            await edits[native_cursor].undo();
        });

        await expect(document.complete_gesture({
            mutationEpoch: document.mutationEpoch,
            ...view_authority(document, 'view-1'),
            revision: 2,
        }, native_history)).resolves.toEqual({
            type: 'accepted', revision: 4, sourceGeneration: 1, changed: false,
        });

        expect(native_history).toHaveBeenCalledTimes(2);
        expect(native_cursor).toBe(0);
        expect(document.cell_value('0:0')).toBe('a');
        expect(document.isDirty).toBe(false);
        expect(edits).toEqual([
            expect.objectContaining({ beforeValue: 'a', afterValue: 'live' }),
            expect.objectContaining({ beforeValue: 'live', afterValue: 'a' }),
        ]);
        await document.dispose();
    });

    it('cancels every immutable segment in one logical gesture', async () => {
        const fs = new MemoryFileSystem();
        fs.set('/table.csv', 'h1\na\n');
        const document = await open_document(fs);
        const edits: CsvDocumentEditEvent[] = [];
        document.on_did_change((event) => edits.push(event));
        await document.apply_cell_input({
            mutationEpoch: document.mutationEpoch,
            ...view_authority(document, 'view-1'), key: '0:0', value: 'first', revision: 0,
        });
        await document.apply_cell_input({
            mutationEpoch: document.mutationEpoch,
            ...view_authority(document, 'view-1'), key: '0:0', value: 'second', revision: 1,
        });
        let cursor = edits.length;
        const native_history = vi.fn(async () => {
            cursor -= 1;
            await edits[cursor].undo();
        });

        await expect(document.cancel_gesture({
            mutationEpoch: document.mutationEpoch,
            ...view_authority(document, 'view-1'),
            revision: 2,
        }, native_history)).resolves.toEqual({
            type: 'accepted', revision: 4, sourceGeneration: 1, changed: true,
        });

        expect(native_history).toHaveBeenCalledTimes(2);
        expect(cursor).toBe(0);
        expect(document.cell_value('0:0')).toBe('a');
        expect(document.isDirty).toBe(false);
        await document.dispose();
    });

    it('cancels the exact clean gesture through native Undo and leaves it redoable', async () => {
        const fs = new MemoryFileSystem();
        fs.set('/table.csv', 'h1\na\n');
        const document = await open_document(fs);
        const edits: CsvDocumentEditEvent[] = [];
        document.on_did_change((event) => edits.push(event));

        await document.apply_cell_input({
            mutationEpoch: document.mutationEpoch,
            ...view_authority(document, 'view-1'), key: '0:0', value: 'live', revision: 0,
        });
        const request = vi.fn(async (direction: 'undo' | 'redo') => {
            expect(direction).toBe('undo');
            await edits[0].undo();
        });
        await expect(document.cancel_gesture(
            { mutationEpoch: document.mutationEpoch, ...view_authority(document, 'view-1'), revision: 1 },
            request,
        )).resolves.toEqual({
            type: 'accepted', revision: 2, sourceGeneration: 1, changed: true,
        });

        expect(request).toHaveBeenCalledOnce();
        expect(document.cell_value('0:0')).toBe('a');
        expect(document.dirty_entry('0:0')).toBeUndefined();
        expect(document.isDirty).toBe(false);
        expect(edits).toHaveLength(1);

        await edits[0].redo();
        expect(document.cell_value('0:0')).toBe('live');
        expect(document.dirty_entry('0:0')).toEqual({ value: 'live', base: 'a' });
        expect(document.isDirty).toBe(true);
        await document.dispose();
    });

    it('cancels back to the value that was already dirty before the gesture', async () => {
        const fs = new MemoryFileSystem();
        fs.set('/table.csv', 'h1\na\n');
        const document = await open_document(fs);
        const edits: CsvDocumentEditEvent[] = [];
        document.on_did_change((event) => edits.push(event));

        await document.apply_cell_input({
            mutationEpoch: document.mutationEpoch,
            ...view_authority(document, 'view-1'), key: '0:0', value: 'first', revision: 0,
        });
        await document.complete_gesture({ mutationEpoch: document.mutationEpoch, ...view_authority(document, 'view-1'), revision: 1 });
        await document.apply_cell_input({
            mutationEpoch: document.mutationEpoch,
            ...view_authority(document, 'view-1'), key: '0:0', value: 'second', revision: 1,
        });
        await expect(document.cancel_gesture(
            { mutationEpoch: document.mutationEpoch, ...view_authority(document, 'view-1'), revision: 2 },
            async () => edits[1].undo(),
        )).resolves.toEqual({
            type: 'accepted', revision: 3, sourceGeneration: 1, changed: true,
        });

        expect(document.cell_value('0:0')).toBe('first');
        expect(document.dirty_entry('0:0')).toEqual({ value: 'first', base: 'a' });
        expect(document.isDirty).toBe(true);
        await document.dispose();
    });

    it('fails closed when native Undo resolves without invoking the pinned callback', async () => {
        const fs = new MemoryFileSystem();
        fs.set('/table.csv', 'h1\na\n');
        const document = await open_document(fs);
        const edits: CsvDocumentEditEvent[] = [];
        document.on_did_change((event) => edits.push(event));
        await document.apply_cell_input({
            mutationEpoch: document.mutationEpoch,
            ...view_authority(document, 'view-1'), key: '0:0', value: 'live', revision: 0,
        });

        await expect(document.cancel_gesture(
            { mutationEpoch: document.mutationEpoch, ...view_authority(document, 'view-1'), revision: 1 },
            async () => undefined,
        )).rejects.toThrow('VS Code did not undo the cancelled CSV gesture.');
        expect(document.cell_value('0:0')).toBe('live');
        expect(document.dirty_entry('0:0')).toEqual({ value: 'live', base: 'a' });

        await expect(document.apply_cell_input({
            mutationEpoch: document.mutationEpoch,
            ...view_authority(document, 'view-1'), key: '0:0', value: 'later', revision: 1,
        })).resolves.toMatchObject({ type: 'accepted', revision: 2 });
        expect(edits).toHaveLength(2);
        await document.dispose();
    });

    it('retains live content when native Undo rejects before its callback', async () => {
        const fs = new MemoryFileSystem();
        fs.set('/table.csv', 'h1\na\n');
        const document = await open_document(fs);
        await document.apply_cell_input({
            mutationEpoch: document.mutationEpoch,
            ...view_authority(document, 'view-1'), key: '0:0', value: 'live', revision: 0,
        });

        await expect(document.cancel_gesture(
            { mutationEpoch: document.mutationEpoch, ...view_authority(document, 'view-1'), revision: 1 },
            async () => { throw new Error('host rejected undo'); },
        )).rejects.toThrow('host rejected undo');
        expect(document.cell_value('0:0')).toBe('live');
        expect(document.dirty_entry('0:0')).toEqual({ value: 'live', base: 'a' });
        await expect(document.resync_snapshot()).resolves.toMatchObject({
            revision: 1,
            dirtyEntries: { '0:0': { value: 'live', base: 'a' } },
        });
        await document.dispose();
    });

    it('retains the reverted state when native Undo rejects after its callback', async () => {
        const fs = new MemoryFileSystem();
        fs.set('/table.csv', 'h1\na\n');
        const document = await open_document(fs);
        let edit: CsvDocumentEditEvent | undefined;
        document.on_did_change((event) => { edit = event; });
        await document.apply_cell_input({
            mutationEpoch: document.mutationEpoch,
            ...view_authority(document, 'view-1'), key: '0:0', value: 'live', revision: 0,
        });

        await expect(document.cancel_gesture(
            { mutationEpoch: document.mutationEpoch, ...view_authority(document, 'view-1'), revision: 1 },
            async () => {
                await edit!.undo();
                throw new Error('host rejected after callback');
            },
        )).rejects.toThrow('host rejected after callback');
        expect(document.cell_value('0:0')).toBe('a');
        expect(document.dirty_entry('0:0')).toBeUndefined();
        expect(document.revision).toBe(2);
        await document.dispose();
    });

    it('rejects the wrong native callback without mutating it or deadlocking later work', async () => {
        const fs = new MemoryFileSystem();
        fs.set('/table.csv', 'h1,h2\na,b\n');
        const document = await open_document(fs);
        const edits: CsvDocumentEditEvent[] = [];
        document.on_did_change((event) => edits.push(event));
        await document.apply_cell_input({
            mutationEpoch: document.mutationEpoch,
            ...view_authority(document, 'view-1'), key: '0:0', value: 'first', revision: 0,
        });
        await document.complete_gesture({ mutationEpoch: document.mutationEpoch, ...view_authority(document, 'view-1'), revision: 1 });
        await document.apply_cell_input({
            mutationEpoch: document.mutationEpoch,
            ...view_authority(document, 'view-1'), key: '0:1', value: 'second', revision: 1,
        });

        await expect(document.cancel_gesture(
            { mutationEpoch: document.mutationEpoch, ...view_authority(document, 'view-1'), revision: 2 },
            async () => edits[0].undo(),
        )).rejects.toThrow('VS Code did not invoke the cancelled CSV gesture callback.');
        expect(document.cell_value('0:0')).toBe('first');
        expect(document.cell_value('0:1')).toBe('second');
        expect(document.revision).toBe(2);

        await expect(document.apply_cell_input({
            mutationEpoch: document.mutationEpoch,
            ...view_authority(document, 'view-1'), key: '0:1', value: 'later', revision: 2,
        })).resolves.toMatchObject({ type: 'accepted', revision: 3 });
        expect(document.cell_value('0:1')).toBe('later');
        await document.dispose();
    });

    it('retains wrong-direction failure even if the exact Undo follows', async () => {
        const fs = new MemoryFileSystem();
        fs.set('/table.csv', 'h1\na\n');
        const document = await open_document(fs);
        let edit: CsvDocumentEditEvent | undefined;
        document.on_did_change((event) => { edit = event; });
        await document.apply_cell_input({
            mutationEpoch: document.mutationEpoch,
            ...view_authority(document, 'view-1'), key: '0:0', value: 'live', revision: 0,
        });

        await expect(document.cancel_gesture(
            { mutationEpoch: document.mutationEpoch, ...view_authority(document, 'view-1'), revision: 1 },
            async () => {
                await expect(edit!.redo()).rejects.toThrow(
                    'VS Code invoked the wrong CSV history callback direction.',
                );
                await expect(edit!.undo()).rejects.toThrow(
                    'VS Code invoked the wrong CSV history callback direction.',
                );
            },
        )).rejects.toThrow(
            'VS Code invoked the wrong CSV history callback direction.',
        );
        expect(document.cell_value('0:0')).toBe('live');
        expect(document.revision).toBe(1);
        await document.dispose();
    });

    it('retains duplicate-callback failure after the first exact Undo succeeds', async () => {
        const fs = new MemoryFileSystem();
        fs.set('/table.csv', 'h1\na\n');
        const document = await open_document(fs);
        let edit: CsvDocumentEditEvent | undefined;
        document.on_did_change((event) => { edit = event; });
        await document.apply_cell_input({
            mutationEpoch: document.mutationEpoch,
            ...view_authority(document, 'view-1'), key: '0:0', value: 'live', revision: 0,
        });

        await expect(document.cancel_gesture(
            { mutationEpoch: document.mutationEpoch, ...view_authority(document, 'view-1'), revision: 1 },
            async () => {
                await edit!.undo();
                await expect(edit!.undo()).rejects.toThrow(
                    'VS Code invoked more than one CSV history callback.',
                );
            },
        )).rejects.toThrow('VS Code invoked more than one CSV history callback.');
        expect(document.cell_value('0:0')).toBe('a');
        expect(document.revision).toBe(2);

        await edit!.redo();
        expect(document.cell_value('0:0')).toBe('live');
        expect(document.revision).toBe(3);
        await document.dispose();
    });

    it('holds later sibling input behind the complete cancellation transaction', async () => {
        const fs = new MemoryFileSystem();
        fs.set('/table.csv', 'h1,h2\na,b\n');
        const document = await open_document(fs);
        await attach_test_view(document, 'view-2');
        let edit: CsvDocumentEditEvent | undefined;
        document.on_did_change((event) => { edit = event; });
        await document.apply_cell_input({
            mutationEpoch: document.mutationEpoch,
            ...view_authority(document, 'view-1'), key: '0:0', value: 'live', revision: 0,
        });
        const host_started = deferred();
        const release_host = deferred();
        const cancellation = document.cancel_gesture(
            { mutationEpoch: document.mutationEpoch, ...view_authority(document, 'view-1'), revision: 1 },
            async () => {
                host_started.resolve();
                await release_host.promise;
                await edit!.undo();
            },
        );
        await host_started.promise;

        let sibling_settled = false;
        const sibling = document.apply_cell_input({
            mutationEpoch: document.mutationEpoch,
            ...view_authority(document, 'view-2'), key: '0:1', value: 'later', revision: 2,
        }).finally(() => { sibling_settled = true; });
        await Promise.resolve();
        expect(sibling_settled).toBe(false);
        expect(document.cell_value('0:0')).toBe('live');
        expect(document.cell_value('0:1')).toBe('b');

        release_host.resolve();
        await expect(cancellation).resolves.toMatchObject({
            type: 'accepted', revision: 2, changed: true,
        });
        await expect(sibling).resolves.toMatchObject({
            type: 'accepted', revision: 3, changed: true,
        });
        expect(document.cell_value('0:0')).toBe('a');
        expect(document.cell_value('0:1')).toBe('later');
        await document.dispose();
    });

    it('holds backup, save, revert, and snapshot work behind cancellation', async () => {
        const fs = new MemoryFileSystem();
        fs.set('/table.csv', 'h1\na\n');
        const document = await open_document(fs);
        let edit: CsvDocumentEditEvent | undefined;
        document.on_did_change((event) => { edit = event; });
        await document.apply_cell_input({
            mutationEpoch: document.mutationEpoch,
            ...view_authority(document, 'view-1'), key: '0:0', value: 'live', revision: 0,
        });
        const host_started = deferred();
        const release_host = deferred();
        const cancellation = document.cancel_gesture(
            { mutationEpoch: document.mutationEpoch, ...view_authority(document, 'view-1'), revision: 1 },
            async () => {
                host_started.resolve();
                await release_host.promise;
                await edit!.undo();
            },
        );
        await host_started.promise;

        const settled = {
            backup: false,
            save: false,
            revert: false,
            snapshot: false,
        };
        const backup = document.backup().finally(() => { settled.backup = true; });
        const save = document.save().finally(() => { settled.save = true; });
        const revert = document.revert().finally(() => { settled.revert = true; });
        const snapshot = document.resync_snapshot().finally(() => {
            settled.snapshot = true;
        });
        await Promise.resolve();
        expect(settled).toEqual({
            backup: false, save: false, revert: false, snapshot: false,
        });

        release_host.resolve();
        await expect(cancellation).resolves.toMatchObject({
            type: 'accepted', revision: 2, changed: true,
        });
        await expect(Promise.all([backup, save, revert, snapshot])).resolves.toBeDefined();
        expect(settled).toEqual({
            backup: true, save: true, revert: true, snapshot: true,
        });
        expect(document.cell_value('0:0')).toBe('a');
        await document.dispose();
    });

    it('does not request native Undo when earlier sibling input supersedes the gesture', async () => {
        const fs = new MemoryFileSystem();
        fs.set('/table.csv', 'h1,h2\na,b\n');
        const document = await open_document(fs);
        await attach_test_view(document, 'view-2');
        await document.apply_cell_input({
            mutationEpoch: document.mutationEpoch,
            ...view_authority(document, 'view-1'), key: '0:0', value: 'first', revision: 0,
        });
        const sibling = document.apply_cell_input({
            mutationEpoch: document.mutationEpoch,
            ...view_authority(document, 'view-2'), key: '0:1', value: 'second', revision: 1,
        });
        const request = vi.fn();
        const cancellation = document.cancel_gesture(
            { mutationEpoch: document.mutationEpoch, ...view_authority(document, 'view-1'), revision: 1 },
            request,
        );

        await expect(sibling).resolves.toMatchObject({
            type: 'accepted', revision: 2,
        });
        await expect(cancellation).resolves.toEqual({
            type: 'resync', revision: 2, sourceGeneration: 1,
        });
        expect(request).not.toHaveBeenCalled();
        expect(document.cell_value('0:0')).toBe('first');
        expect(document.cell_value('0:1')).toBe('second');
        await document.dispose();
    });

    it('serializes ordinary native Undo and Redo commands per document', async () => {
        const fs = new MemoryFileSystem();
        fs.set('/table.csv', 'h1\na\n');
        const document = await open_document(fs);
        let edit: CsvDocumentEditEvent | undefined;
        document.on_did_change((event) => { edit = event; });
        await document.apply_cell_input({
            mutationEpoch: document.mutationEpoch,
            ...view_authority(document, 'view-1'), key: '0:0', value: 'live', revision: 0,
        });
        const undo_started = deferred();
        const release_undo = deferred();
        const undo = document.run_native_history_command('undo', async () => {
            undo_started.resolve();
            await release_undo.promise;
            await edit!.undo();
        });
        await undo_started.promise;

        let redo_started = false;
        const redo = document.run_native_history_command('redo', async () => {
            redo_started = true;
            await edit!.redo();
        });
        await Promise.resolve();
        expect(redo_started).toBe(false);
        expect(document.cell_value('0:0')).toBe('live');

        release_undo.resolve();
        await undo;
        expect(document.cell_value('0:0')).toBe('a');
        await redo;
        expect(redo_started).toBe(true);
        expect(document.cell_value('0:0')).toBe('live');
        await document.dispose();
    });

    it('drains admitted native history before disposal completes', async () => {
        const fs = new MemoryFileSystem();
        fs.set('/table.csv', 'h1\na\n');
        const document = await open_document(fs);
        let edit: CsvDocumentEditEvent | undefined;
        document.on_did_change((event) => { edit = event; });
        await document.apply_cell_input({
            mutationEpoch: document.mutationEpoch,
            ...view_authority(document, 'view-1'), key: '0:0', value: 'live', revision: 0,
        });
        const host_started = deferred();
        const release_host = deferred();
        const cancellation = document.cancel_gesture(
            { mutationEpoch: document.mutationEpoch, ...view_authority(document, 'view-1'), revision: 1 },
            async () => {
                host_started.resolve();
                await release_host.promise;
                await edit!.undo();
            },
        );
        await host_started.promise;

        let idle_settled = false;
        let disposal_settled = false;
        const idle = document.when_idle().finally(() => { idle_settled = true; });
        const disposal = document.dispose().finally(() => { disposal_settled = true; });
        await Promise.resolve();
        expect(idle_settled).toBe(false);
        expect(disposal_settled).toBe(false);

        release_host.resolve();
        await expect(cancellation).resolves.toMatchObject({
            type: 'accepted', revision: 2, changed: true,
        });
        await disposal;
        await idle;
        expect(idle_settled).toBe(true);
        expect(disposal_settled).toBe(true);
    });

    it('keeps a pre-backup logical gesture cancellable when no more input follows', async () => {
        const fs = new MemoryFileSystem();
        fs.set('/table.csv', 'h1\na\n');
        const document = await open_document(fs);
        const edits: CsvDocumentEditEvent[] = [];
        document.on_did_change((event) => edits.push(event));

        await document.apply_cell_input({
            mutationEpoch: document.mutationEpoch,
            ...view_authority(document, 'view-1'), key: '0:0', value: 'A', revision: 0,
        });
        await document.backup();
        const native_history = vi.fn(async () => edits[0].undo());

        await expect(document.cancel_gesture({
            mutationEpoch: document.mutationEpoch,
            ...view_authority(document, 'view-1'),
            revision: 1,
        }, native_history)).resolves.toMatchObject({ changed: true, revision: 2 });
        expect(native_history).toHaveBeenCalledOnce();
        expect(document.cell_value('0:0')).toBe('a');
        expect(document.isDirty).toBe(false);
        await document.dispose();
    });

    it('keeps pre- and post-backup segments in one cancellable logical gesture', async () => {
        const fs = new MemoryFileSystem();
        fs.set('/table.csv', 'h1\na\n');
        const document = await open_document(fs);
        const edits: CsvDocumentEditEvent[] = [];
        document.on_did_change((event) => edits.push(event));

        await document.apply_cell_input({
            mutationEpoch: document.mutationEpoch,
            ...view_authority(document, 'view-1'), key: '0:0', value: 'A', revision: 0,
        });
        await document.backup();
        await document.apply_cell_input({
            mutationEpoch: document.mutationEpoch,
            ...view_authority(document, 'view-1'), key: '0:0', value: 'AA', revision: 1,
        });
        let cursor = edits.length;
        const native_history = vi.fn(async () => {
            cursor -= 1;
            await edits[cursor].undo();
        });

        await expect(document.cancel_gesture({
            mutationEpoch: document.mutationEpoch,
            ...view_authority(document, 'view-1'),
            revision: 2,
        }, native_history)).resolves.toMatchObject({ changed: true, revision: 4 });
        expect(edits).toEqual([
            expect.objectContaining({ beforeValue: 'a', afterValue: 'A' }),
            expect.objectContaining({ beforeValue: 'A', afterValue: 'AA' }),
        ]);
        expect(native_history).toHaveBeenCalledTimes(2);
        expect(document.cell_value('0:0')).toBe('a');
        expect(document.isDirty).toBe(false);
        await document.dispose();
    });

    it('publishes edits queued during native Save only after its host promise settles', async () => {
        const fs = new MemoryFileSystem();
        fs.set('/table.csv', 'h1\na\n');
        const document = await open_document(fs);
        await document.apply_cell_input({
            mutationEpoch: document.mutationEpoch,
            ...view_authority(document, 'view-1'), key: '0:0', value: 'saved', revision: 0,
        });
        await document.complete_gesture({ mutationEpoch: document.mutationEpoch, ...view_authority(document, 'view-1'), revision: 1 });
        const write_started = deferred();
        const release_write = deferred();
        fs.onWrite = async () => {
            write_started.resolve();
            await release_write.promise;
        };
        let host_save_settled = false;
        const edit_observations: boolean[] = [];
        document.on_did_change(() => edit_observations.push(host_save_settled));

        const saving = document.save_for_host().then(() => {
            host_save_settled = true;
        });
        await write_started.promise;
        const later_edit = document.apply_cell_input({
            mutationEpoch: document.mutationEpoch,
            ...view_authority(document, 'view-1'), key: '0:0', value: 'later', revision: 1,
        });
        release_write.resolve();
        await saving;
        await later_edit;

        expect(edit_observations).toEqual([true]);
        expect(document.dirty_entry('0:0')).toEqual({
            value: 'later', base: 'saved',
        });
        await document.dispose();
    });

    it('runs a direct native Undo before renderer input queued on Save settlement', async () => {
        const fs = new MemoryFileSystem();
        fs.set('/table.csv', 'h1\na\n');
        const document = await open_document(fs);
        const edits: CsvDocumentEditEvent[] = [];
        document.on_did_change((event) => edits.push(event));
        await document.apply_cell_input({
            mutationEpoch: document.mutationEpoch,
            ...view_authority(document, 'view-1'), key: '0:0', value: 'saved', revision: 0,
        });
        await document.complete_gesture({
            mutationEpoch: document.mutationEpoch,
            ...view_authority(document, 'view-1'), revision: 1,
        });
        const write_started = deferred();
        const release_write = deferred();
        fs.onWrite = async () => {
            write_started.resolve();
            await release_write.promise;
        };

        const saving = document.save_for_host();
        await write_started.promise;
        const later_edit = document.apply_cell_input({
            mutationEpoch: document.mutationEpoch,
            ...view_authority(document, 'view-1'), key: '0:0', value: 'later', revision: 1,
        });
        release_write.resolve();
        await saving;
        const undoing = edits[0].undo();

        await undoing;
        await expect(later_edit).resolves.toMatchObject({
            type: 'resync', revision: 2,
        });
        expect(edits).toHaveLength(1);
        expect(document.cell_value('0:0')).toBe('a');
        expect(document.dirty_entry('0:0')).toEqual({
            value: 'a', base: 'saved',
        });
        await document.dispose();
    });

    it('bounds the settlement drain and admits no callback past the bound', async () => {
        const rearm_target = MAX_SETTLEMENT_DRAIN_PASSES + 8;
        const fs = new MemoryFileSystem();
        // One row per re-arm so every history callback targets a distinct cell and
        // always changes a value; re-arming one cell degrades into no-ops, which emit
        // no content event and would end the chain long before the bound.
        fs.set('/table.csv', `h1\n${Array.from(
            { length: rearm_target + 2 }, (_unused, row) => `r${row}`,
        ).join('\n')}\n`);
        const document = await open_document(fs, '/table.csv', { maxRows: 5_000 });
        const edits: CsvDocumentEditEvent[] = [];
        document.on_did_change((event) => edits.push(event));
        for (let row = 0; row < rearm_target + 1; row += 1) {
            await document.apply_cell_input({
                mutationEpoch: document.mutationEpoch,
                ...view_authority(document, 'view-1'),
                key: `${row}:0`,
                value: `edited-${row}`,
                revision: document.revision,
            });
            await document.complete_gesture({
                mutationEpoch: document.mutationEpoch,
                ...view_authority(document, 'view-1'),
                revision: document.revision,
            });
        }
        expect(edits.length).toBeGreaterThan(rearm_target);

        const write_started = deferred();
        const release_write = deferred();
        fs.onWrite = async () => {
            write_started.resolve();
            await release_write.promise;
        };

        const saving = document.save_for_host();
        await write_started.promise;
        // Queued behind the settlement gate; it must still complete once the drain
        // gives up re-arming and releases.
        const queued_backup = document.backup();
        release_write.resolve();
        await saving;

        // Re-arm from *inside* each running callback, so the settlement tail is
        // already re-armed at the instant the drain loop observes it. Without the
        // bound this parks the operation queue behind the gate forever.
        let rearms = 0;
        // Callbacks that have started mutating (their history content event landed)
        // but have not finished. A callback the gate refuses after admission closes
        // parks behind the gate without mutating, so it never counts here. The drain
        // must not release while any accepted callback is still mid-transaction.
        const outstanding = new Set<CsvDocumentEditEvent>();
        let outstanding_at_release: CsvDocumentEditEvent[] = [];
        const mark_release = (): void => {
            outstanding_at_release = [...outstanding];
        };
        void queued_backup.then(mark_release, mark_release);
        const pending: Array<Promise<unknown>> = [];
        let armed: CsvDocumentEditEvent | undefined;
        const arm = (edit: CsvDocumentEditEvent): void => {
            rearms += 1;
            armed = edit;
            pending.push(edit.undo().then(
                () => { outstanding.delete(edit); },
                () => { outstanding.delete(edit); },
            ));
        };
        const mutations = document.on_did_change_content((event) => {
            if (event.type !== 'cell' || event.origin === 'input') return;
            if (armed) outstanding.add(armed);
            if (rearms >= rearm_target) return;
            arm(edits[rearms % edits.length]);
        });
        arm(edits[0]);
        for (let guard = 0; guard < rearm_target * 4 && pending.length > 0; guard += 1) {
            await pending.shift();
        }
        mutations.dispose();

        expect(rearms).toBeGreaterThan(MAX_SETTLEMENT_DRAIN_PASSES);
        // The gate released despite unbounded re-arming, so queued work ran.
        await expect(queued_backup).resolves.toBeInstanceOf(Uint8Array);
        // The core guarantee: at the bound the drain closed admission and waited for
        // the last accepted callback, so nothing it accepted was still running when
        // queued work was let through.
        // The core guarantee. Exactly one callback may still be outstanding when the
        // gate releases: the straggler armed after the drain closed admission, which
        // parks behind the gate without mutating. Releasing before awaiting the last
        // *accepted* callback leaves a second one outstanding — one the gate admitted
        // and then abandoned mid-transaction, free to overwrite the queued work.
        expect(outstanding_at_release.length).toBeLessThanOrEqual(1);
        // And the document is still usable afterwards — the gate was removed, not
        // merely bypassed.
        await document.when_idle();
        await expect(document.attach_view('view-2')).resolves.toBeDefined();
        await document.dispose();
    });

    it('derives undo and redo against the current source, including after save', async () => {
        const fs = new MemoryFileSystem();
        fs.set('/table.csv', 'h1\na\n');
        const document = await open_document(fs);
        let edit: CsvDocumentEditEvent | undefined;
        document.on_did_change((event) => { edit = event; });
        await document.apply_cell_input({
            mutationEpoch: document.mutationEpoch,
            ...view_authority(document, 'view-1'), key: '0:0', value: 'saved', revision: 0,
        });
        expect(edit).toBeDefined();
        await document.save();
        expect(fs.text('/table.csv')).toBe('h1\nsaved\n');
        expect(document.isDirty).toBe(false);

        await edit!.undo();
        expect(document.cell_value('0:0')).toBe('a');
        expect(document.dirty_entry('0:0')).toEqual({ value: 'a', base: 'saved' });
        await edit!.redo();
        expect(document.cell_value('0:0')).toBe('saved');
        expect(document.dirty_entry('0:0')).toBeUndefined();
        await document.dispose();
    });

    it('rejects stale revisions and emits a resync request without mutating state', async () => {
        const fs = new MemoryFileSystem();
        fs.set('/table.csv', 'h1\na\n');
        const document = await open_document(fs);
        const resync = vi.fn();
        document.on_did_request_resync(resync);
        await document.apply_cell_input({
            mutationEpoch: document.mutationEpoch,
            ...view_authority(document, 'view-1'), key: '0:0', value: 'A', revision: 0,
        });
        const result = await document.apply_cell_input({
            mutationEpoch: document.mutationEpoch,
            ...view_authority(document, 'view-1'), key: '0:0', value: 'stale', revision: 0,
        });
        expect(result).toEqual({ type: 'resync', revision: 1, sourceGeneration: 1 });
        expect(document.cell_value('0:0')).toBe('A');
        expect(resync).toHaveBeenCalledWith({
            ...view_authority(document, 'view-1'), expectedRevision: 0, actualRevision: 1, sourceGeneration: 1,
            expectedMutationEpoch: 1, actualMutationEpoch: 1,
        });
        const snapshot = await document.resync_snapshot();
        expect(snapshot.dirtyEntries).toEqual({ '0:0': { value: 'A', base: 'a' } });
        await document.dispose();
    });

    it('closes the requesting view gesture when stale completion requires resynchronization', async () => {
        const fs = new MemoryFileSystem();
        fs.set('/table.csv', 'h1\na\n');
        const document = await open_document(fs);
        const edits: CsvDocumentEditEvent[] = [];
        document.on_did_change((event) => edits.push(event));
        await document.apply_cell_input({
            mutationEpoch: document.mutationEpoch,
            ...view_authority(document, 'view-1'), key: '0:0', value: 'A', revision: 0,
        });

        expect(await document.complete_gesture({ mutationEpoch: document.mutationEpoch, ...view_authority(document, 'view-1'), revision: 0 }))
            .toEqual({ type: 'resync', revision: 1, sourceGeneration: 1 });
        await document.resync_snapshot();
        await document.apply_cell_input({
            mutationEpoch: document.mutationEpoch,
            ...view_authority(document, 'view-1'), key: '0:0', value: 'AA', revision: 1,
        });
        expect(edits).toHaveLength(2);
        expect(edits[1].beforeValue).toBe('A');
        expect(edits[1].afterValue).toBe('AA');
        await document.dispose();
    });

    it('serializes same-revision view mutations and targets stale resync without closing the accepted gesture', async () => {
        const fs = new MemoryFileSystem();
        fs.set('/table.csv', 'h1\na\n');
        const document = await open_document(fs);
        await attach_test_view(document, 'view-2');
        const edits: CsvDocumentEditEvent[] = [];
        const resync = vi.fn();
        document.on_did_change((event) => edits.push(event));
        document.on_did_request_resync(resync);

        const first = document.apply_cell_input({
            mutationEpoch: document.mutationEpoch,
            ...view_authority(document, 'view-1'), key: '0:0', value: 'A', revision: 0,
        });
        const second = document.apply_cell_input({
            mutationEpoch: document.mutationEpoch,
            ...view_authority(document, 'view-2'), key: '0:0', value: 'B', revision: 0,
        });

        await expect(first).resolves.toEqual({
            type: 'accepted', revision: 1, sourceGeneration: 1, changed: true,
        });
        await expect(second).resolves.toEqual({
            type: 'resync', revision: 1, sourceGeneration: 1,
        });
        expect(resync).toHaveBeenCalledOnce();
        expect(resync).toHaveBeenCalledWith({
            ...view_authority(document, 'view-2'), expectedRevision: 0, actualRevision: 1, sourceGeneration: 1,
            expectedMutationEpoch: 1, actualMutationEpoch: 1,
        });

        await document.apply_cell_input({
            mutationEpoch: document.mutationEpoch,
            ...view_authority(document, 'view-1'), key: '0:0', value: 'AA', revision: 1,
        });
        expect(edits).toHaveLength(2);
        expect(edits[0]).toMatchObject({ beforeValue: 'a', afterValue: 'A' });
        expect(edits[1]).toMatchObject({ beforeValue: 'A', afterValue: 'AA' });
        await document.dispose();
    });

    it('rejects every later optimistic input from a view chain after a sibling wins', async () => {
        const fs = new MemoryFileSystem();
        fs.set('/table.csv', 'h1,h2\na,b\n');
        const document = await open_document(fs);
        await attach_test_view(document, 'view-2');
        const edits: CsvDocumentEditEvent[] = [];
        const resync = vi.fn();
        document.on_did_change((event) => edits.push(event));
        document.on_did_request_resync(resync);
        const stale_view_authority = view_authority(document, 'view-1');

        const sibling = document.apply_cell_input({
            mutationEpoch: document.mutationEpoch,
            ...view_authority(document, 'view-2'),
            key: '0:1', value: 'sibling', revision: 0,
        });
        const first_stale = document.apply_cell_input({
            mutationEpoch: document.mutationEpoch,
            ...stale_view_authority,
            key: '0:0', value: 'first stale', revision: 0,
        });
        const later_stale = document.apply_cell_input({
            mutationEpoch: document.mutationEpoch,
            ...stale_view_authority,
            key: '0:0', value: 'later stale', revision: 1,
        });

        await expect(sibling).resolves.toMatchObject({
            type: 'accepted', revision: 1, changed: true,
        });
        await expect(first_stale).resolves.toEqual({
            type: 'resync', revision: 1, sourceGeneration: 1,
        });
        await expect(later_stale).resolves.toEqual({
            type: 'resync', revision: 1, sourceGeneration: 1,
        });
        expect(resync).toHaveBeenCalledOnce();
        expect(edits).toHaveLength(1);
        expect(edits[0]).toMatchObject({ key: '0:1', afterValue: 'sibling' });
        expect(document.cell_value('0:0')).toBe('a');
        expect(document.cell_value('0:1')).toBe('sibling');

        await expect(document.apply_cell_input({
            mutationEpoch: document.mutationEpoch,
            ...view_authority(document, 'view-1'),
            key: '0:0', value: 'fresh', revision: 1,
        })).resolves.toMatchObject({ type: 'accepted', revision: 2, changed: true });
        expect(document.cell_value('0:0')).toBe('fresh');
        await document.dispose();
    });

    it('rejects every later optimistic input from a view chain after native Undo wins', async () => {
        const fs = new MemoryFileSystem();
        fs.set('/table.csv', 'h1\na\n');
        const document = await open_document(fs);
        const edits: CsvDocumentEditEvent[] = [];
        const resync = vi.fn();
        document.on_did_change((event) => edits.push(event));
        document.on_did_request_resync(resync);
        await document.apply_cell_input({
            mutationEpoch: document.mutationEpoch,
            ...view_authority(document, 'view-1'),
            key: '0:0', value: 'live', revision: 0,
        });
        const stale_view_authority = view_authority(document, 'view-1');

        const undo = document.run_native_history_command(
            'undo',
            async () => edits[0].undo(),
        );
        const first_stale = document.apply_cell_input({
            mutationEpoch: document.mutationEpoch,
            ...stale_view_authority,
            key: '0:0', value: 'first stale', revision: 1,
        });
        const later_stale = document.apply_cell_input({
            mutationEpoch: document.mutationEpoch,
            ...stale_view_authority,
            key: '0:0', value: 'later stale', revision: 2,
        });

        await expect(undo).resolves.toBeUndefined();
        await expect(first_stale).resolves.toEqual({
            type: 'resync', revision: 2, sourceGeneration: 1,
        });
        await expect(later_stale).resolves.toEqual({
            type: 'resync', revision: 2, sourceGeneration: 1,
        });
        expect(resync).toHaveBeenCalledOnce();
        expect(edits).toHaveLength(1);
        expect(document.revision).toBe(2);
        expect(document.cell_value('0:0')).toBe('a');
        expect(document.isDirty).toBe(false);
        await document.dispose();
    });

    it('keeps completion, cancellation, detach, and explicit resync closure view-scoped', async () => {
        const fs = new MemoryFileSystem();
        fs.set('/table.csv', 'h1\na\n');
        const document = await open_document(fs);
        await attach_test_view(document, 'view-2');
        const edits: CsvDocumentEditEvent[] = [];
        document.on_did_change((event) => edits.push(event));
        await document.apply_cell_input({
            mutationEpoch: document.mutationEpoch,
            ...view_authority(document, 'view-1'), key: '0:0', value: 'A', revision: 0,
        });

        const native_history = vi.fn();
        await expect(document.complete_gesture({ mutationEpoch: document.mutationEpoch, ...view_authority(document, 'view-2'), revision: 0 }))
            .resolves.toMatchObject({ type: 'resync', revision: 1 });
        await expect(document.cancel_gesture(
            { mutationEpoch: document.mutationEpoch, ...view_authority(document, 'view-2'), revision: 0 },
            native_history,
        )).resolves.toMatchObject({ type: 'resync', revision: 1 });
        await document.complete_gesture({ mutationEpoch: document.mutationEpoch, ...view_authority(document, 'view-2'), revision: 1 });
        await document.cancel_gesture(
            { mutationEpoch: document.mutationEpoch, ...view_authority(document, 'view-2'), revision: 1 },
            native_history,
        );
        expect(native_history).not.toHaveBeenCalled();
        expect(await resync_test_view(document, 'view-2')).toMatchObject({
            revision: 1, sourceGeneration: 1,
        });
        await document.detach_view('view-2');
        await document.apply_cell_input({
            mutationEpoch: document.mutationEpoch,
            ...view_authority(document, 'view-1'), key: '0:0', value: 'AA', revision: 1,
        });

        expect(edits).toHaveLength(2);
        expect(edits[0]).toMatchObject({ beforeValue: 'a', afterValue: 'A' });
        expect(edits[1]).toMatchObject({ beforeValue: 'A', afterValue: 'AA' });
        await document.dispose();
    });

    it('closes gestures globally when another view has an accepted mutation', async () => {
        const fs = new MemoryFileSystem();
        fs.set('/table.csv', 'h1,h2\na,b\n');
        const document = await open_document(fs);
        await attach_test_view(document, 'view-2');
        const edits: CsvDocumentEditEvent[] = [];
        document.on_did_change((event) => edits.push(event));

        await document.apply_cell_input({
            mutationEpoch: document.mutationEpoch,
            ...view_authority(document, 'view-1'), key: '0:0', value: 'A', revision: 0,
        });
        await document.apply_cell_input({
            mutationEpoch: document.mutationEpoch,
            ...view_authority(document, 'view-2'), key: '0:1', value: 'B', revision: 1,
        });
        await document.apply_cell_input({
            mutationEpoch: document.mutationEpoch,
            ...view_authority(document, 'view-1'), key: '0:0', value: 'AA', revision: 2,
        });

        expect(edits).toHaveLength(3);
        expect(edits.map((edit) => ({
            key: edit.key,
            before: edit.beforeValue,
            after: edit.afterValue,
        }))).toEqual([
            { key: '0:0', before: 'a', after: 'A' },
            { key: '0:1', before: 'b', after: 'B' },
            { key: '0:0', before: 'A', after: 'AA' },
        ]);
        await document.dispose();
    });

    it('keeps the accepted view gesture open when a sibling mutation is rejected', async () => {
        const fs = new MemoryFileSystem();
        fs.set('/table.csv', 'h1,h2\na,b\n');
        const document = await CsvCustomDocument.open({
            resource: uri('/table.csv'),
            fs,
            maxFileSizeBytes: 1_024,
            maxRows: 100,
            backupLimits: { maxEntryBytes: 4 },
        });
        await attach_test_view(document, 'view-1');
        await attach_test_view(document, 'view-2');
        const edits: CsvDocumentEditEvent[] = [];
        document.on_did_change((event) => edits.push(event));

        await document.apply_cell_input({
            mutationEpoch: document.mutationEpoch,
            ...view_authority(document, 'view-1'), key: '0:0', value: 'x', revision: 0,
        });
        await expect(document.apply_cell_input({
            mutationEpoch: document.mutationEpoch,
            ...view_authority(document, 'view-2'), key: '0:1', value: '12345', revision: 1,
        })).rejects.toMatchObject({ code: 'sizeLimit' });
        expect(document.revision).toBe(1);
        await document.apply_cell_input({
            mutationEpoch: document.mutationEpoch,
            ...view_authority(document, 'view-1'), key: '0:0', value: 'y', revision: 1,
        });

        expect(edits).toHaveLength(2);
        expect(edits[0]).toMatchObject({ beforeValue: 'a', afterValue: 'x' });
        expect(edits[1]).toMatchObject({ beforeValue: 'x', afterValue: 'y' });
        expect(document.cell_value('0:1')).toBe('b');
        await document.dispose();
    });

    it('queues explicit view resync after earlier input and closes that view gesture', async () => {
        const fs = new MemoryFileSystem();
        fs.set('/table.csv', 'h1\na\n');
        const document = await open_document(fs);
        const edits: CsvDocumentEditEvent[] = [];
        document.on_did_change((event) => edits.push(event));

        const input = document.apply_cell_input({
            mutationEpoch: document.mutationEpoch,
            ...view_authority(document, 'view-1'), key: '0:0', value: 'A', revision: 0,
        });
        const resync = resync_test_view(document, 'view-1');
        await input;
        await expect(resync).resolves.toMatchObject({
            revision: 1,
            sourceGeneration: 1,
            dirtyEntries: { '0:0': { value: 'A', base: 'a' } },
        });
        await document.apply_cell_input({
            mutationEpoch: document.mutationEpoch,
            ...view_authority(document, 'view-1'), key: '0:0', value: 'AA', revision: 1,
        });

        expect(edits).toHaveLength(2);
        expect(edits[1]).toMatchObject({ beforeValue: 'A', afterValue: 'AA' });
        await document.dispose();
    });

    it('attaches multiple views idempotently and refuses edits to truncated sources', async () => {
        const fs = new MemoryFileSystem();
        fs.set('/table.csv', 'h1\na\nb\n');
        const document = await open_document(fs, '/table.csv', { maxRows: 1 });
        expect(await attach_test_view(document, 'view-2')).toMatchObject({
            type: 'attached',
            viewMutationEpoch: expect.any(Number),
        });
        expect(await attach_test_view(document, 'view-1')).toMatchObject({
            type: 'attached',
            viewMutationEpoch: expect.any(Number),
        });
        expect(await attach_test_view(document, 'view-2')).toMatchObject({
            type: 'attached',
            viewMutationEpoch: expect.any(Number),
        });
        await expect(document.apply_cell_input({
            mutationEpoch: document.mutationEpoch,
            ...view_authority(document, 'view-1'), key: '0:0', value: 'A', revision: 0,
        })).rejects.toMatchObject({ code: 'truncated' });
        await expect(document.save()).rejects.toMatchObject({ code: 'truncated' });
        expect(fs.text('/table.csv')).toBe('h1\na\nb\n');
        await document.dispose();
    });
});

describe('CsvCustomDocument open observation', () => {
    it('clamps oversized admission to the immutable backup source ceiling before reading', async () => {
        const fs = new MemoryFileSystem();
        fs.set('/table.csv', 'h1\na\n');
        fs.stat = vi.fn(async () => ({
            size: CSV_DOCUMENT_BACKUP_V2_MAX_SOURCE_BYTES + 1,
            mtime: 1,
        }));

        await expect(CsvCustomDocument.open({
            resource: uri('/table.csv'),
            fs,
            maxFileSizeBytes: CSV_DOCUMENT_BACKUP_V2_MAX_SOURCE_BYTES + 1,
            maxRows: 100,
        })).rejects.toMatchObject({ code: 'tooLarge' });

        expect(fs.readSpy).not.toHaveBeenCalled();
    });

    it('installs refresh before reading and reconciles a signal queued before construction', async () => {
        const fs = new MemoryFileSystem();
        fs.set('/table.csv', 'h1\ninitial\n');
        let notify: (() => Promise<void>) | undefined;
        const dispose = vi.fn();
        const stat = fs.stat.bind(fs);
        let stat_calls = 0;
        fs.stat = async (resource) => {
            const observed = await stat(resource);
            stat_calls += 1;
            expect(notify).toBeTypeOf('function');
            if (stat_calls === 2) {
                fs.set('/table.csv', 'h1\nchanged during open\n', { mtime: 2 });
                await notify!();
            }
            return observed;
        };

        const document = await CsvCustomDocument.open({
            resource: uri('/table.csv'),
            fs,
            maxFileSizeBytes: 1_024,
            maxRows: 100,
            refreshFactory(_identity, on_external_change) {
                notify = on_external_change;
                return {
                    reserve_post_save: () => ({ cancel() {} }),
                    request: async () => ({ type: 'completed' }),
                    dispose,
                };
            },
        });

        expect(document.cell_value('0:0')).toBe('changed during open');
        expect(document.sourceGeneration).toBe(2);
        expect(document.mutationEpoch).toBe(2);
        expect(document.conflict).toEqual({ type: 'none' });
        await document.dispose();
        expect(dispose).toHaveBeenCalledOnce();
    });

    it('settles queued readiness and disposes observation when open fails', async () => {
        const fs = new MemoryFileSystem();
        fs.set('/table.csv', 'h1\na\n');
        fs.failNextRead = new Error('open read failed');
        let notify: (() => Promise<void>) | undefined;
        const dispose = vi.fn();

        const opening = CsvCustomDocument.open({
            resource: uri('/table.csv'),
            fs,
            maxFileSizeBytes: 1_024,
            maxRows: 100,
            refreshFactory(_identity, on_external_change) {
                notify = on_external_change;
                return {
                    reserve_post_save: () => ({ cancel() {} }),
                    request: async () => ({ type: 'completed' }),
                    dispose,
                };
            },
        });
        expect(notify).toBeTypeOf('function');
        await expect(notify!()).resolves.toBeUndefined();
        await expect(opening).rejects.toThrow('open read failed');
        expect(dispose).toHaveBeenCalledOnce();
    });
});

describe('CsvCustomDocument backup and restore', () => {
    it('rejects edits that cannot be represented by the configured backup limits', async () => {
        const fs = new MemoryFileSystem();
        fs.set('/table.csv', 'h1,h2\na,b\n');
        const document = await CsvCustomDocument.open({
            resource: uri('/table.csv'),
            fs,
            maxFileSizeBytes: 1_024,
            maxRows: 100,
            backupLimits: { maxEntryBytes: 4, maxDirtyEntries: 1 },
        });
        await attach_test_view(document, 'view-1');
        const clean_backup_bytes = (await document.backup()).byteLength;

        await expect(document.apply_cell_input({
            mutationEpoch: document.mutationEpoch,
            ...view_authority(document, 'view-1'), key: '0:0', value: '12345', revision: 0,
        })).rejects.toMatchObject({ code: 'sizeLimit' });
        expect(document.revision).toBe(0);
        expect(document.isDirty).toBe(false);

        await document.apply_cell_input({
            mutationEpoch: document.mutationEpoch,
            ...view_authority(document, 'view-1'), key: '0:0', value: 'x', revision: 0,
        });
        await expect(document.apply_cell_input({
            mutationEpoch: document.mutationEpoch,
            ...view_authority(document, 'view-1'), key: '0:1', value: 'y', revision: 1,
        })).rejects.toMatchObject({ code: 'countLimit' });
        expect(document.revision).toBe(1);
        expect(document.dirtyCount).toBe(1);
        expect(document.cell_value('0:1')).toBe('b');
        await expect(document.backup()).resolves.toBeInstanceOf(Uint8Array);
        await document.dispose();

        const total_limited = await CsvCustomDocument.open({
            resource: uri('/table.csv'),
            fs,
            maxFileSizeBytes: 1_024,
            maxRows: 100,
            backupLimits: { maxBackupBytes: clean_backup_bytes + 16 },
        });
        await attach_test_view(total_limited, 'view-1');
        await expect(total_limited.apply_cell_input({
            mutationEpoch: total_limited.mutationEpoch,
            ...view_authority(total_limited, 'view-1'), key: '0:0', value: 'x', revision: 0,
        })).rejects.toMatchObject({ code: 'sizeLimit' });
        expect(total_limited.revision).toBe(0);
        expect(total_limited.isDirty).toBe(false);
        await total_limited.dispose();
    });

    it('queues backup after live input and restores the active value with target reconciliation', async () => {
        const fs = new MemoryFileSystem();
        fs.set('/table.csv', 'h1,h2\na,b\n');
        const document = await open_document(fs);
        const edit = document.apply_cell_input({
            mutationEpoch: document.mutationEpoch,
            ...view_authority(document, 'view-1'), key: '0:1', value: 'active', revision: 0,
        });
        const backup = document.backup();
        await edit;
        const bytes = await backup;

        fs.set('/table.csv', 'h1,h2\nexternal,x\n', { mtime: 99 });
        fs.readSpy.mockClear();
        const restored = await CsvCustomDocument.restore({
            resource: uri('/table.csv'),
            fs,
            maxFileSizeBytes: 1_024 * 1_024,
            maxRows: 1_000,
            backup: bytes,
        });
        expect(fs.readSpy).toHaveBeenCalled();
        expect(restored.restorationState).toMatchObject({
            restoredFromBackup: true,
            backupVersion: 2,
        });
        expect(restored.conflict).toEqual({ type: 'externalChange' });
        expect(restored.cell_value('0:0')).toBe('a');
        expect(restored.cell_value('0:1')).toBe('active');
        expect(restored.dirty_entry('0:1')).toEqual({ value: 'active', base: 'b' });
        await restored.dispose();
        await document.dispose();
    });

    it('restores with its creation-time file-size admission after the setting is lowered', async () => {
        const fs = new MemoryFileSystem();
        fs.set('/table.csv', 'h1\ncreation-time-source\n');
        const document = await CsvCustomDocument.open({
            resource: uri('/table.csv'),
            fs,
            maxFileSizeBytes: 1_024,
            maxRows: 100,
        });
        await attach_test_view(document, 'view-1');
        await document.apply_cell_input({
            mutationEpoch: document.mutationEpoch,
            ...view_authority(document, 'view-1'), key: '0:0', value: 'dirty', revision: 0,
        });
        const backup = await document.backup();

        const restored = await CsvCustomDocument.restore({
            resource: uri('/table.csv'),
            fs,
            maxFileSizeBytes: 4,
            maxRows: 100,
            backup,
        });

        expect(restored.cell_value('0:0')).toBe('dirty');
        expect(restored.dirty_entry('0:0')).toEqual({
            value: 'dirty', base: 'creation-time-source',
        });
        await expect(restored.backup()).resolves.toBeInstanceOf(Uint8Array);
        await restored.dispose();
        await document.dispose();
    });

    it('restores with its creation-time row admission after the setting is lowered', async () => {
        const fs = new MemoryFileSystem();
        fs.set('/table.csv', 'h1\none\ntwo\n');
        const document = await CsvCustomDocument.open({
            resource: uri('/table.csv'),
            fs,
            maxFileSizeBytes: 1_024,
            maxRows: 100,
        });
        await attach_test_view(document, 'view-1');
        await document.apply_cell_input({
            mutationEpoch: document.mutationEpoch,
            ...view_authority(document, 'view-1'), key: '1:0', value: 'dirty second row', revision: 0,
        });
        const backup = await document.backup();

        const restored = await CsvCustomDocument.restore({
            resource: uri('/table.csv'),
            fs,
            maxFileSizeBytes: 1_024,
            maxRows: 1,
            backup,
        });

        expect(restored.metadata).toMatchObject({
            sourceRowCount: 2,
            rowCount: 2,
        });
        expect(restored.metadata.truncationMessage).toBeUndefined();
        expect(restored.cell_value('1:0')).toBe('dirty second row');
        expect(restored.dirty_entry('1:0')).toEqual({
            value: 'dirty second row', base: 'two',
        });
        await restored.dispose();
        await document.dispose();
    });

    it('fails restore when a backup dirty base or coordinate does not match its source', async () => {
        const fs = new MemoryFileSystem();
        fs.set('/table.csv', 'h1\na\n');
        const source = encoder.encode('h1\na\n');
        const identity = create_resource_identity(uri('/table.csv'));
        const targetBasis = {
            stat: { size: source.byteLength, mtime: 1 },
            digest: csv_content_digest(source),
        };
        const bad_base = encode_csv_document_backup({
            identity,
            delimiter: ',',
            targetBasis,
            sourceBytes: source,
            maxRows: 100,
            dirtyEntries: new Map([['0:0', { value: 'x', base: 'wrong' }]]),
            limits: { maxSourceBytes: 1_024 },
        });
        await expect(CsvCustomDocument.restore({
            resource: uri('/table.csv'), fs, maxFileSizeBytes: 1_024, maxRows: 100,
            backup: bad_base,
        })).rejects.toMatchObject({ code: 'malformed' });

        const bad_column = encode_csv_document_backup({
            identity,
            delimiter: ',',
            targetBasis,
            sourceBytes: source,
            maxRows: 100,
            dirtyEntries: new Map([['0:9', { value: 'x', base: '' }]]),
            limits: { maxSourceBytes: 1_024 },
        });
        await expect(CsvCustomDocument.restore({
            resource: uri('/table.csv'), fs, maxFileSizeBytes: 1_024, maxRows: 100,
            backup: bad_column,
        })).rejects.toMatchObject({ code: 'malformed' });
    });
});

describe('CsvCustomDocument save, Save As, revert, and disposal', () => {
    it('rejects multi-view Save As before destination work or source mutation', async () => {
        const fs = new MemoryFileSystem();
        fs.set('/table.csv', 'h1\na\n');
        const document = await open_document(fs);
        await document.apply_cell_input({
            mutationEpoch: document.mutationEpoch,
            ...view_authority(document, 'view-1'), key: '0:0', value: 'edited', revision: 0,
        });
        await attach_test_view(document, 'view-2');
        fs.writeSpy.mockClear();
        const state_before = await document.resync_snapshot();

        await expect(document.save_as(uri('/copy.csv'))).rejects.toThrow(
            'Save As is unavailable while this CSV is open in multiple Table Viewer views. '
            + 'Close the other views and try again.',
        );

        expect(fs.writeSpy).not.toHaveBeenCalled();
        expect(fs.files.has('/copy.csv')).toBe(false);
        expect(await document.resync_snapshot()).toEqual(state_before);
        await document.dispose();
    });

    it('preserves the original dirty document after Save As writes a destination copy', async () => {
        const fs = new MemoryFileSystem();
        fs.set('/table.csv', 'h1\na\n');
        const document = await open_document(fs);
        await document.apply_cell_input({
            mutationEpoch: document.mutationEpoch,
            ...view_authority(document, 'view-1'), key: '0:0', value: 'edited', revision: 0,
        });
        fs.set('/table.csv', 'h1\nx\n', { mtime: 1 });
        await expect(document.save()).rejects.toMatchObject({ code: 'externalChange' });
        expect(document.isDirty).toBe(true);
        expect(document.conflict).toEqual({ type: 'externalChange' });
        expect(document.cell_value('0:0')).toBe('edited');

        const result = await document.save_as(uri('/copy.csv'));
        expect(result.sourceGeneration).toBe(1);
        expect(fs.text('/copy.csv')).toBe('h1\nedited\n');
        expect(fs.text('/table.csv')).toBe('h1\nx\n');
        expect(document.uri.path).toBe('/table.csv');
        expect(document.cell_value('0:0')).toBe('edited');
        expect(document.isDirty).toBe(true);
        expect(document.conflict).toEqual({ type: 'externalChange' });
        await document.dispose();
    });

    it('treats Save As to the current resource as a fenced save and adopts it', async () => {
        const fs = new MemoryFileSystem();
        fs.set('/table.csv', 'h1\na\n');
        const document = await open_document(fs);
        await document.apply_cell_input({
            mutationEpoch: document.mutationEpoch,
            ...view_authority(document, 'view-1'), key: '0:0', value: 'first', revision: 0,
        });

        const result = await document.save_as(uri('/table.csv'));

        expect(fs.text('/table.csv')).toBe('h1\nfirst\n');
        expect(document.isDirty).toBe(false);
        expect(document.sourceGeneration).toBe(2);
        expect(result.sourceGeneration).toBe(2);
        expect(document.cell_value('0:0')).toBe('first');

        await document.apply_cell_input({
            mutationEpoch: document.mutationEpoch,
            ...view_authority(document, 'view-1'), key: '0:0', value: 'second', revision: 1,
        });
        await document.save();
        expect(fs.text('/table.csv')).toBe('h1\nsecond\n');
        expect(document.isDirty).toBe(false);
        await document.dispose();
    });

    it('rejects same-resource Save As after an external change', async () => {
        const fs = new MemoryFileSystem();
        fs.set('/table.csv', 'h1\na\n');
        const document = await open_document(fs);
        await document.apply_cell_input({
            mutationEpoch: document.mutationEpoch,
            ...view_authority(document, 'view-1'), key: '0:0', value: 'mine', revision: 0,
        });
        fs.set('/table.csv', 'h1\nexternal\n', { mtime: 2 });

        await expect(document.save_as(uri('/table.csv'))).rejects.toMatchObject({
            code: 'externalChange',
        });

        expect(fs.text('/table.csv')).toBe('h1\nexternal\n');
        expect(document.isDirty).toBe(true);
        expect(document.cell_value('0:0')).toBe('mine');
        expect(document.conflict).toEqual({ type: 'externalChange' });
        await document.dispose();
    });

    it('rejects view attachment while Save As owns the document lifecycle', async () => {
        const fs = new MemoryFileSystem();
        fs.set('/table.csv', 'h1\na\n');
        const document = await open_document(fs);
        const write_started = deferred();
        const release_write = deferred();
        fs.onWrite = async (resource) => {
            if (resource.path !== '/copy.csv') return;
            write_started.resolve();
            await release_write.promise;
        };

        const saving = document.save_as(uri('/copy.csv'));
        await write_started.promise;
        await expect(document.attach_view('view-2')).rejects.toThrow(
            'Save As is unavailable while this CSV is open in multiple Table Viewer views.',
        );
        release_write.resolve();
        await saving;

        expect(await attach_test_view(document, 'view-2')).toMatchObject({
            type: 'attached',
            viewMutationEpoch: expect.any(Number),
        });
        await document.dispose();
    });

    it('re-encodes the header when Save As changes the delimiter', async () => {
        const fs = new MemoryFileSystem();
        fs.set('/table.csv', '"h,1",h2\na,b\n');
        const document = await open_document(fs);
        await document.apply_cell_input({
            mutationEpoch: document.mutationEpoch,
            ...view_authority(document, 'view-1'), key: '0:1', value: 'B', revision: 0,
        });

        await document.save_as(uri('/copy.tsv'), { delimiter: '\t' });
        expect(fs.text('/copy.tsv')).toBe('h,1\th2\na\tB\n');
        expect(document.uri.path).toBe('/table.csv');
        expect(document.delimiter).toBe(',');
        expect(document.isDirty).toBe(true);
        await document.dispose();
    });

    it('preserves the current TSV delimiter for extensionless Save As', async () => {
        const fs = new MemoryFileSystem();
        fs.set('/table.tsv', 'h1\th2\na\tb\n');
        const document = await open_document(fs, '/table.tsv');

        await document.save_as(uri('/copy'));

        expect(fs.text('/copy')).toBe('h1\th2\na\tb\n');
        expect(document.delimiter).toBe('\t');
        await document.dispose();
    });

    it('supports an explicit TSV-to-CSV delimiter switch', async () => {
        const fs = new MemoryFileSystem();
        fs.set('/table.tsv', 'h1\th2\na\tb\n');
        const document = await open_document(fs, '/table.tsv');
        await document.apply_cell_input({
            mutationEpoch: document.mutationEpoch,
            ...view_authority(document, 'view-1'), key: '0:1', value: 'B', revision: 0,
        });

        await document.save_as(uri('/copy.csv'), { delimiter: ',' });

        expect(fs.text('/copy.csv')).toBe('h1,h2\na,B\n');
        expect(document.delimiter).toBe('\t');
        expect(document.isDirty).toBe(true);
        await document.dispose();
    });

    it('uses a temporary destination refresh subscription without rebinding Save As', async () => {
        const fs = new MemoryFileSystem();
        fs.set('/table.csv', 'h1\na\n');
        const subscriptions: Array<{
            path: string;
            reserve_post_save: ReturnType<typeof vi.fn>;
            request: ReturnType<typeof vi.fn>;
            dispose: ReturnType<typeof vi.fn>;
        }> = [];
        const document = await CsvCustomDocument.open({
            resource: uri('/table.csv'),
            fs,
            maxFileSizeBytes: 1_024,
            maxRows: 100,
            refreshFactory(identity) {
                const subscription = {
                    path: identity.uri.path,
                    reserve_post_save: vi.fn(() => ({ cancel: vi.fn() })),
                    request: vi.fn(async () => ({ type: 'completed' as const })),
                    dispose: vi.fn(),
                };
                subscriptions.push(subscription);
                return subscription;
            },
        });
        await attach_test_view(document, 'view-1');
        await document.apply_cell_input({
            mutationEpoch: document.mutationEpoch,
            ...view_authority(document, 'view-1'), key: '0:0', value: 'copy', revision: 0,
        });
        const result = await document.save_as(uri('/copy.csv'));
        await result.postSaveCompletion;
        expect(subscriptions.map((entry) => entry.path)).toEqual(['/table.csv', '/copy.csv']);
        expect(subscriptions[0].reserve_post_save).not.toHaveBeenCalled();
        expect(subscriptions[0].dispose).not.toHaveBeenCalled();
        expect(subscriptions[1].reserve_post_save).toHaveBeenCalledOnce();
        expect(subscriptions[1].request).toHaveBeenCalledWith('postSave');
        expect(subscriptions[1].dispose).toHaveBeenCalledOnce();
        expect(document.uri.path).toBe('/table.csv');
        await document.dispose();
        expect(subscriptions[0].dispose).toHaveBeenCalledOnce();
    });

    it('revert replaces state only after a successful stable read and parse', async () => {
        const fs = new MemoryFileSystem();
        fs.set('/table.csv', 'h1\na\n');
        const document = await open_document(fs);
        await document.apply_cell_input({
            mutationEpoch: document.mutationEpoch,
            ...view_authority(document, 'view-1'), key: '0:0', value: 'edited', revision: 0,
        });
        fs.set('/table.csv', 'h1\nnew\n', { mtime: 2 });
        fs.failNextRead = new Error('read failed');
        await expect(document.revert()).rejects.toThrow('read failed');
        expect(document.cell_value('0:0')).toBe('edited');
        expect(document.isDirty).toBe(true);

        await document.revert();
        expect(document.cell_value('0:0')).toBe('new');
        expect(document.isDirty).toBe(false);
        expect(document.sourceGeneration).toBe(2);
        await document.dispose();
    });

    it('retains external evidence when input removes the final dirty entry with native history', async () => {
        const fs = new MemoryFileSystem();
        fs.set('/table.csv', 'h1\na\n');
        const document = await open_document(fs);
        const replacements: string[] = [];
        document.on_did_change_content((event) => {
            if (event.type === 'sourceReplaced') replacements.push(event.reason);
        });
        await document.apply_cell_input({
            mutationEpoch: document.mutationEpoch,
            ...view_authority(document, 'view-1'), key: '0:0', value: 'mine', revision: 0,
        });
        fs.set('/table.csv', 'h1\nexternal\n', { mtime: 2 });
        await document.notify_external_change();
        expect(document.conflict).toEqual({ type: 'externalChange' });
        const old_epoch = document.mutationEpoch;

        await expect(document.apply_cell_input({
            mutationEpoch: document.mutationEpoch,
            ...view_authority(document, 'view-1'), key: '0:0', value: 'a', revision: 1,
        })).resolves.toEqual({
            type: 'accepted', revision: 2, sourceGeneration: 1, changed: true,
        });

        expect(document.cell_value('0:0')).toBe('a');
        expect(document.isDirty).toBe(false);
        expect(document.conflict).toEqual({ type: 'externalChange' });
        expect(document.mutationEpoch).toBe(old_epoch);
        expect(replacements).toEqual([]);
        await document.dispose();
    });

    it('retains external evidence when native Undo removes the final dirty entry', async () => {
        const fs = new MemoryFileSystem();
        fs.set('/table.csv', 'h1\na\n');
        const document = await open_document(fs);
        let edit: CsvDocumentEditEvent | undefined;
        document.on_did_change((event) => { edit = event; });
        await document.apply_cell_input({
            mutationEpoch: document.mutationEpoch,
            ...view_authority(document, 'view-1'), key: '0:0', value: 'mine', revision: 0,
        });
        await document.complete_gesture({
            mutationEpoch: document.mutationEpoch,
            ...view_authority(document, 'view-1'),
            revision: 1,
        });
        fs.set('/table.csv', 'h1\nexternal\n', { mtime: 2 });
        await expect(document.save()).rejects.toMatchObject({ code: 'externalChange' });

        await document.run_native_history_command('undo', async () => {
            await edit!.undo();
        });

        expect(document.cell_value('0:0')).toBe('a');
        expect(document.isDirty).toBe(false);
        expect(document.conflict).toEqual({ type: 'externalChange' });
        expect(document.sourceGeneration).toBe(1);
        expect(document.mutationEpoch).toBe(1);
        await document.dispose();
    });

    it('treats a stable same-digest watcher target as a source no-op', async () => {
        const fs = new MemoryFileSystem();
        fs.set('/table.csv', 'h1,h2\na,b\n');
        const document = await open_document(fs);
        const replacements: string[] = [];
        document.on_did_change_content((event) => {
            if (event.type === 'sourceReplaced') replacements.push(event.reason);
        });
        const source_generation = document.sourceGeneration;
        const mutation_epoch = document.mutationEpoch;
        const revision = document.revision;
        fs.set('/table.csv', 'h1,h2\na,b\n', { mtime: 99 });

        await document.notify_external_change();

        expect(document.sourceGeneration).toBe(source_generation);
        expect(document.mutationEpoch).toBe(mutation_epoch);
        expect(document.revision).toBe(revision);
        expect(document.cell_value('0:0')).toBe('a');
        expect(document.conflict).toEqual({ type: 'none' });
        expect(replacements).toEqual([]);
        await document.dispose();
    });

    it('preserves one logical gesture across a same-digest watcher notification', async () => {
        const fs = new MemoryFileSystem();
        fs.set('/table.csv', 'h1\na\n');
        const document = await open_document(fs);
        const edits: CsvDocumentEditEvent[] = [];
        document.on_did_change((event) => edits.push(event));
        await document.apply_cell_input({
            mutationEpoch: document.mutationEpoch,
            ...view_authority(document, 'view-1'), key: '0:0', value: 'first', revision: 0,
        });
        fs.set('/table.csv', 'h1\na\n', { mtime: 99 });
        await document.notify_external_change();
        await document.apply_cell_input({
            mutationEpoch: document.mutationEpoch,
            ...view_authority(document, 'view-1'), key: '0:0', value: 'second', revision: 1,
        });
        let cursor = edits.length;
        const native_history = vi.fn(async () => {
            cursor -= 1;
            await edits[cursor].undo();
        });

        await expect(document.cancel_gesture({
            mutationEpoch: document.mutationEpoch,
            ...view_authority(document, 'view-1'),
            revision: 2,
        }, native_history)).resolves.toEqual({
            type: 'accepted', revision: 4, sourceGeneration: 1, changed: true,
        });

        expect(native_history).toHaveBeenCalledTimes(2);
        expect(cursor).toBe(0);
        expect(document.cell_value('0:0')).toBe('a');
        expect(document.isDirty).toBe(false);
        await document.dispose();
    });

    it('clears a dirty external-change conflict when the target returns to the source digest', async () => {
        const fs = new MemoryFileSystem();
        fs.set('/table.csv', 'h1\na\n');
        const document = await open_document(fs);
        await document.apply_cell_input({
            mutationEpoch: document.mutationEpoch,
            ...view_authority(document, 'view-1'), key: '0:0', value: 'mine', revision: 0,
        });
        fs.set('/table.csv', 'h1\nexternal\n', { mtime: 2 });
        await document.notify_external_change();
        expect(document.conflict).toEqual({ type: 'externalChange' });
        fs.set('/table.csv', 'h1\na\n', { mtime: 3 });

        await document.notify_external_change();

        expect(document.conflict).toEqual({ type: 'none' });
        expect(document.cell_value('0:0')).toBe('mine');
        expect(document.isDirty).toBe(true);
        expect(document.sourceGeneration).toBe(1);
        expect(document.mutationEpoch).toBe(1);
        await document.apply_cell_input({
            mutationEpoch: document.mutationEpoch,
            ...view_authority(document, 'view-1'), key: '0:0', value: 'a', revision: 1,
        });
        expect(document.isDirty).toBe(false);
        expect(document.sourceGeneration).toBe(1);
        await document.dispose();
    });

    it('clears a deletion conflict after the original target digest returns', async () => {
        const fs = new MemoryFileSystem();
        fs.set('/table.csv', 'h1\na\n');
        const document = await open_document(fs);
        fs.files.delete('/table.csv');
        await expect(document.notify_external_change()).rejects.toThrow('not found');
        expect(document.conflict).toEqual({ type: 'externalChange' });
        fs.set('/table.csv', 'h1\na\n', { mtime: 2 });

        await document.notify_external_change();

        expect(document.conflict).toEqual({ type: 'none' });
        expect(document.cell_value('0:0')).toBe('a');
        expect(document.sourceGeneration).toBe(1);
        expect(document.mutationEpoch).toBe(1);
        await document.dispose();
    });

    it('clears a read-failure conflict after a same-digest retry succeeds', async () => {
        const fs = new MemoryFileSystem();
        fs.set('/table.csv', 'h1\na\n');
        const document = await open_document(fs);
        fs.failNextRead = new Error('read failed');
        await expect(document.notify_external_change()).rejects.toThrow('read failed');
        expect(document.conflict).toEqual({ type: 'externalChange' });

        await document.notify_external_change();

        expect(document.conflict).toEqual({ type: 'none' });
        expect(document.cell_value('0:0')).toBe('a');
        expect(document.sourceGeneration).toBe(1);
        expect(document.mutationEpoch).toBe(1);
        await document.dispose();
    });

    it('rejects old-epoch input queued behind a clean external source replacement', async () => {
        const fs = new MemoryFileSystem();
        fs.set('/table.csv', 'h1,h2\na,b\nc,d\n');
        const document = await open_document(fs);
        const old_epoch = document.mutationEpoch;
        const read_started = deferred();
        const release_read = deferred();
        const read_file = fs.read_file.bind(fs);
        let hold_next_read = true;
        fs.read_file = async (resource) => {
            if (hold_next_read) {
                hold_next_read = false;
                read_started.resolve();
                await release_read.promise;
            }
            return read_file(resource);
        };
        fs.set('/table.csv', 'h1,h2\nc,d\na,b\n', { mtime: 2 });

        const reload = document.notify_external_change();
        await read_started.promise;
        const stale_input = document.apply_cell_input({
            mutationEpoch: old_epoch,
            ...view_authority(document, 'view-1'),
            key: '0:0',
            value: 'stale renderer value',
            revision: 0,
        });
        release_read.resolve();

        await reload;
        await expect(stale_input).resolves.toEqual({
            type: 'resync', revision: 0, sourceGeneration: 2,
        });
        expect(document.mutationEpoch).toBe(old_epoch + 1);
        expect(document.cell_value('0:0')).toBe('c');
        expect(document.isDirty).toBe(false);
        expect(document.revision).toBe(0);
        await document.dispose();
    });

    it('retains a saved source epoch and valid callbacks across an external reorder', async () => {
        const fs = new MemoryFileSystem();
        fs.set('/table.csv', 'h1,h2\na,b\nc,d\n');
        const document = await open_document(fs);
        let edit: CsvDocumentEditEvent | undefined;
        document.on_did_change((event) => { edit = event; });
        await document.apply_cell_input({
            mutationEpoch: document.mutationEpoch,
            ...view_authority(document, 'view-1'), key: '0:0', value: 'A', revision: 0,
        });
        await document.complete_gesture({
            mutationEpoch: document.mutationEpoch,
            ...view_authority(document, 'view-1'), revision: 1,
        });
        await document.save();
        const saved_epoch = document.mutationEpoch;
        fs.set('/table.csv', 'h1,h2\nc,d\nA,b\n', { mtime: 99 });

        await document.notify_external_change();
        expect(document.mutationEpoch).toBe(saved_epoch);
        expect(document.sourceGeneration).toBe(2);
        expect(document.conflict).toEqual({ type: 'externalChange' });
        expect(document.cell_value('0:0')).toBe('A');

        await edit!.undo();
        expect(document.cell_value('0:0')).toBe('a');
        expect(document.dirty_entry('0:0')).toEqual({ value: 'a', base: 'A' });
        await edit!.redo();
        expect(document.cell_value('0:0')).toBe('A');
        expect(document.isDirty).toBe(false);
        expect(document.conflict).toEqual({ type: 'externalChange' });
        expect(document.sourceGeneration).toBe(2);
        expect(document.mutationEpoch).toBe(saved_epoch);
        expect(document.revision).toBe(3);
        await document.dispose();
    });

    it('auto-adopts external changes again only after native Revert host settlement', async () => {
        const fs = new MemoryFileSystem();
        fs.set('/table.csv', 'h1\na\n');
        const document = await open_document(fs);
        let edit: CsvDocumentEditEvent | undefined;
        document.on_did_change((event) => { edit = event; });
        await document.apply_cell_input({
            mutationEpoch: document.mutationEpoch,
            ...view_authority(document, 'view-1'), key: '0:0', value: 'saved', revision: 0,
        });
        await document.save();
        fs.set('/table.csv', 'h1\nfirst external\n', { mtime: 2 });
        await document.notify_external_change();
        expect(document.cell_value('0:0')).toBe('saved');
        expect(document.conflict).toEqual({ type: 'externalChange' });

        await document.revert_for_host();
        expect(document.cell_value('0:0')).toBe('first external');
        expect(document.sourceGeneration).toBe(3);
        expect(document.mutationEpoch).toBe(2);

        fs.set('/table.csv', 'h1\nsecond external\n', { mtime: 3 });
        // These queue while the zero-delay host settlement gate is still installed.
        // The stale callback must stay fail-closed, while observable adoption proves
        // the history-risk reset ran before the gate released queued operations.
        const stale_callback = edit!.undo();
        const adoption = document.notify_external_change();
        await expect(stale_callback).rejects.toThrow(
            'CSV history callback belongs to a replaced source.',
        );
        await adoption;

        expect(document.cell_value('0:0')).toBe('second external');
        expect(document.conflict).toEqual({ type: 'none' });
        expect(document.sourceGeneration).toBe(4);
        expect(document.mutationEpoch).toBe(3);
        await document.dispose();
    });

    it('does not adopt a revert cancelled during its final stable-read stat', async () => {
        const fs = new MemoryFileSystem();
        fs.set('/table.csv', 'h1\na\n');
        const document = await open_document(fs);
        await document.apply_cell_input({
            mutationEpoch: document.mutationEpoch,
            ...view_authority(document, 'view-1'), key: '0:0', value: 'edited', revision: 0,
        });
        fs.set('/table.csv', 'h1\nnew\n', { mtime: 2 });
        const cancellation = { isCancellationRequested: false };
        const stat = fs.stat.bind(fs);
        let stat_calls = 0;
        fs.stat = async (resource) => {
            const result = await stat(resource);
            stat_calls += 1;
            if (stat_calls === 2) cancellation.isCancellationRequested = true;
            return result;
        };

        await expect(document.revert(cancellation)).rejects.toMatchObject({ code: 'cancelled' });
        expect(document.cell_value('0:0')).toBe('edited');
        expect(document.isDirty).toBe(true);
        expect(document.revision).toBe(1);
        expect(document.sourceGeneration).toBe(1);
        await document.dispose();
    });

    it('rejects an edited replacement that would exceed the document size limit', async () => {
        const fs = new MemoryFileSystem();
        fs.set('/table.csv', 'h1\na\n');
        const document = await CsvCustomDocument.open({
            resource: uri('/table.csv'), fs, maxFileSizeBytes: 8, maxRows: 100,
        });
        await attach_test_view(document, 'view-1');
        await document.apply_cell_input({
            mutationEpoch: document.mutationEpoch,
            ...view_authority(document, 'view-1'), key: '0:0', value: 'far-too-long', revision: 0,
        });
        await expect(document.save()).rejects.toMatchObject({ code: 'tooLarge' });
        expect(document.isDirty).toBe(true);
        expect(fs.text('/table.csv')).toBe('h1\na\n');
        await document.dispose();
    });

    it('finishes a started save when cancellation arrives during write', async () => {
        const fs = new MemoryFileSystem();
        fs.set('/table.csv', 'h1\na\n');
        const document = await open_document(fs);
        await document.apply_cell_input({
            mutationEpoch: document.mutationEpoch,
            ...view_authority(document, 'view-1'), key: '0:0', value: 'saved', revision: 0,
        });
        const token = { isCancellationRequested: false };
        fs.onWrite = () => { token.isCancellationRequested = true; };
        await document.save(token);
        expect(fs.text('/table.csv')).toBe('h1\nsaved\n');
        expect(document.isDirty).toBe(false);
        await document.dispose();
    });

    it('is idempotently disposable and rejects future operations', async () => {
        const fs = new MemoryFileSystem();
        fs.set('/table.csv', 'h1\na\n');
        const document = await open_document(fs);
        const first = document.dispose();
        const second = document.dispose();
        expect(second).toBe(first);
        await first;
        await expect(document.backup()).rejects.toThrow('disposing');
        await expect(document.attach_view('later')).rejects.toThrow('disposing');
    });
});
