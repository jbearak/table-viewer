import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as vscode from 'vscode';
import { open_csv_table } from '../csv-panel';
import { dispose_csv_preview, show_csv_preview } from '../csv-preview';
import { CsvDataSource } from '../data-source/csv-source';
import type { FileStateStore } from '../state';
import * as vscode_mock from './mocks/vscode';

const enc = new TextEncoder();

function deferred<T>() {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((r) => { resolve = r; });
    return { promise, resolve };
}

async function flush_promises(): Promise<void> {
    for (let i = 0; i < 10; i++) {
        await Promise.resolve();
    }
}

function state_store(): FileStateStore {
    return {
        get: () => ({}),
        set: async () => {},
    };
}

function uri(path: string): vscode.Uri {
    return vscode_mock.Uri.file(path) as unknown as vscode.Uri;
}

function view_column(column: number): vscode.ViewColumn {
    return column as vscode.ViewColumn;
}

function meta_reloads(panel: { __messages: unknown[] }) {
    return panel.__messages.filter((message): message is { type: string; meta: { sheets: { rowCount: number }[] } } => (
        typeof message === 'object'
        && message !== null
        && 'type' in message
        && message.type === 'metaReload'
    ));
}

function sheet_meta(panel: { __messages: unknown[] }) {
    return panel.__messages.filter((message): message is { type: string; previewMode?: boolean; meta: { sheets: { rowCount: number }[] } } => (
        typeof message === 'object'
        && message !== null
        && 'type' in message
        && message.type === 'sheetMeta'
    ));
}

beforeEach(() => {
    dispose_csv_preview();
    vi.restoreAllMocks();
    vscode_mock.__reset();
});

describe('CSV reload races', () => {
    it('mock event disposables unregister handlers', async () => {
        let calls = 0;
        const watcher = vscode_mock.workspace.createFileSystemWatcher();
        const disposable = watcher.onDidChange(() => { calls++; });

        disposable.dispose();
        await watcher.__fireChange();

        expect(calls).toBe(0);
    });

    it('CSV table ignores an older reload and sends sheetMeta when the newer reload is first delivery', async () => {
        const older = deferred<Uint8Array>();
        const newer = deferred<Uint8Array>();
        const reads = [older, newer];
        const close_spy = vi.spyOn(CsvDataSource.prototype, 'close');
        let mtime = 0;

        vscode_mock.__setStatImplementation(async () => ({ size: 100, mtime: ++mtime }));
        vscode_mock.__setReadFileImplementation(async () => reads.shift()!.promise);

        open_csv_table(uri('/tmp/race.csv'), uri('/ext'), state_store(), new Set());
        const watcher = vscode_mock.__getWatchers()[0];
        const first_reload = watcher.__fireChange();
        const second_reload = watcher.__fireChange();

        newer.resolve(enc.encode('n\n1\n2\n'));
        await second_reload;
        older.resolve(enc.encode('old\n'));
        await first_reload;

        const panel = vscode_mock.__getPanels()[0];
        const metas = sheet_meta(panel);
        expect(metas).toHaveLength(1);
        expect(metas[0].meta.sheets[0].rowCount).toBe(3);
        expect(meta_reloads(panel)).toHaveLength(0);
        expect(close_spy).toHaveBeenCalledTimes(1);
    });

    it('CSV table sends sheetMeta when a watcher reload wins before initial ready completes', async () => {
        const initial = deferred<Uint8Array>();
        const reload = deferred<Uint8Array>();
        const reads = [initial, reload];
        const close_spy = vi.spyOn(CsvDataSource.prototype, 'close');
        let mtime = 0;

        vscode_mock.__setStatImplementation(async () => ({ size: 100, mtime: ++mtime }));
        vscode_mock.__setReadFileImplementation(async () => reads.shift()!.promise);

        open_csv_table(uri('/tmp/race.csv'), uri('/ext'), state_store(), new Set());
        const panel = vscode_mock.__getPanels()[0];
        const initial_ready = panel.__receive({ type: 'ready' });
        const reload_done = vscode_mock.__getWatchers()[0].__fireChange();

        reload.resolve(enc.encode('n\n1\n2\n'));
        await reload_done;
        initial.resolve(enc.encode('old\n'));
        await initial_ready;

        const metas = sheet_meta(panel);
        expect(metas).toHaveLength(1);
        expect(metas[0].meta.sheets[0].rowCount).toBe(3);
        expect(meta_reloads(panel)).toHaveLength(0);
        expect(close_spy).toHaveBeenCalledTimes(1);
    });

    it('CSV table still sends sheetMeta for a post-ready reload after a pre-ready reload completed', async () => {
        const pre_ready_reload = deferred<Uint8Array>();
        const initial = deferred<Uint8Array>();
        const post_ready_reload = deferred<Uint8Array>();
        const reads = [pre_ready_reload, initial, post_ready_reload];

        vscode_mock.__setStatImplementation(async () => ({ size: 100, mtime: 1 }));
        vscode_mock.__setReadFileImplementation(async () => reads.shift()!.promise);

        open_csv_table(uri('/tmp/race.csv'), uri('/ext'), state_store(), new Set());
        const panel = vscode_mock.__getPanels()[0];
        const watcher = vscode_mock.__getWatchers()[0];
        const pre_ready_done = watcher.__fireChange();

        pre_ready_reload.resolve(enc.encode('pre\n'));
        await pre_ready_done;
        panel.__messages.length = 0;

        const initial_ready = panel.__receive({ type: 'ready' });
        const post_ready_done = watcher.__fireChange();

        post_ready_reload.resolve(enc.encode('n\n1\n2\n'));
        await post_ready_done;
        initial.resolve(enc.encode('old\n'));
        await initial_ready;

        const metas = sheet_meta(panel);
        expect(metas).toHaveLength(1);
        expect(metas[0].meta.sheets[0].rowCount).toBe(3);
        expect(meta_reloads(panel)).toHaveLength(0);
    });

    it('CSV table ignores and closes an initial ready load that completes after panel disposal', async () => {
        const initial = deferred<Uint8Array>();
        const close_spy = vi.spyOn(CsvDataSource.prototype, 'close');

        vscode_mock.__setStatImplementation(async () => ({ size: 100, mtime: 1 }));
        vscode_mock.__setReadFileImplementation(async () => initial.promise);

        open_csv_table(uri('/tmp/race.csv'), uri('/ext'), state_store(), new Set());
        const panel = vscode_mock.__getPanels()[0];
        const initial_ready = panel.__receive({ type: 'ready' });

        panel.dispose();
        initial.resolve(enc.encode('old\n'));
        await initial_ready;

        expect(sheet_meta(panel)).toHaveLength(0);
        expect(meta_reloads(panel)).toHaveLength(0);
        expect(close_spy).toHaveBeenCalledTimes(1);
    });

    it('CSV preview ignores an older reload and sends sheetMeta when the newer reload is first delivery', async () => {
        const older = deferred<Uint8Array>();
        const newer = deferred<Uint8Array>();
        const reads = [older, newer];
        const close_spy = vi.spyOn(CsvDataSource.prototype, 'close');

        vscode_mock.__setStatImplementation(async () => ({ size: 100, mtime: 0 }));
        vscode_mock.__setReadFileImplementation(async () => reads.shift()!.promise);

        show_csv_preview(uri('/tmp/race.csv'), uri('/ext'), state_store(), view_column(vscode_mock.ViewColumn.Active));
        const watcher = vscode_mock.__getWatchers()[0];
        const first_reload = watcher.__fireChange();
        const second_reload = watcher.__fireChange();

        newer.resolve(enc.encode('n\n1\n2\n'));
        await second_reload;
        older.resolve(enc.encode('old\n'));
        await first_reload;

        const panel = vscode_mock.__getPanels()[0];
        const metas = sheet_meta(panel);
        expect(metas).toHaveLength(1);
        expect(metas[0].meta.sheets[0].rowCount).toBe(3);
        expect(metas[0].previewMode).toBe(true);
        expect(meta_reloads(panel)).toHaveLength(0);
        expect(close_spy).toHaveBeenCalledTimes(1);
    });

    it('CSV preview sends sheetMeta with previewMode when a watcher reload wins before initial ready completes', async () => {
        const initial = deferred<Uint8Array>();
        const reload = deferred<Uint8Array>();
        const reads = [initial, reload];
        const close_spy = vi.spyOn(CsvDataSource.prototype, 'close');

        vscode_mock.__setStatImplementation(async () => ({ size: 100, mtime: 0 }));
        vscode_mock.__setReadFileImplementation(async () => reads.shift()!.promise);

        show_csv_preview(uri('/tmp/race.csv'), uri('/ext'), state_store(), view_column(vscode_mock.ViewColumn.Active));
        const panel = vscode_mock.__getPanels()[0];
        await panel.__receive({ type: 'ready' });
        const reload_done = vscode_mock.__getWatchers()[0].__fireChange();

        reload.resolve(enc.encode('n\n1\n2\n'));
        await reload_done;
        initial.resolve(enc.encode('old\n'));
        await flush_promises();

        const metas = sheet_meta(panel);
        expect(metas).toHaveLength(1);
        expect(metas[0].meta.sheets[0].rowCount).toBe(3);
        expect(metas[0].previewMode).toBe(true);
        expect(meta_reloads(panel)).toHaveLength(0);
        expect(close_spy).toHaveBeenCalledTimes(1);
    });

    it('CSV preview still sends sheetMeta for a post-ready reload after a pre-ready reload completed', async () => {
        const pre_ready_reload = deferred<Uint8Array>();
        const initial = deferred<Uint8Array>();
        const post_ready_reload = deferred<Uint8Array>();
        const reads = [pre_ready_reload, initial, post_ready_reload];

        vscode_mock.__setStatImplementation(async () => ({ size: 100, mtime: 0 }));
        vscode_mock.__setReadFileImplementation(async () => reads.shift()!.promise);

        show_csv_preview(uri('/tmp/race.csv'), uri('/ext'), state_store(), view_column(vscode_mock.ViewColumn.Active));
        const panel = vscode_mock.__getPanels()[0];
        const watcher = vscode_mock.__getWatchers()[0];
        const pre_ready_done = watcher.__fireChange();

        pre_ready_reload.resolve(enc.encode('pre\n'));
        await pre_ready_done;
        panel.__messages.length = 0;

        await panel.__receive({ type: 'ready' });
        const post_ready_done = watcher.__fireChange();

        post_ready_reload.resolve(enc.encode('n\n1\n2\n'));
        await post_ready_done;
        initial.resolve(enc.encode('old\n'));
        await flush_promises();

        const metas = sheet_meta(panel);
        expect(metas).toHaveLength(1);
        expect(metas[0].meta.sheets[0].rowCount).toBe(3);
        expect(metas[0].previewMode).toBe(true);
        expect(meta_reloads(panel)).toHaveLength(0);
    });

    it('CSV preview reuse ignores an old initial load that completes after the panel is reused', async () => {
        const old_load = deferred<Uint8Array>();
        const new_load = deferred<Uint8Array>();
        const close_spy = vi.spyOn(CsvDataSource.prototype, 'close');

        vscode_mock.__setStatImplementation(async () => ({ size: 100, mtime: 0 }));
        vscode_mock.__setReadFileImplementation(async (request_uri) => (
            request_uri.fsPath === '/tmp/old.csv' ? old_load.promise : new_load.promise
        ));

        show_csv_preview(uri('/tmp/old.csv'), uri('/ext'), state_store(), view_column(vscode_mock.ViewColumn.Active));
        const panel = vscode_mock.__getPanels()[0];
        await panel.__receive({ type: 'ready' });

        show_csv_preview(uri('/tmp/new.csv'), uri('/ext'), state_store(), view_column(vscode_mock.ViewColumn.Active));
        await panel.__receive({ type: 'ready' });

        new_load.resolve(enc.encode('n\n1\n2\n'));
        await flush_promises();
        old_load.resolve(enc.encode('old\n'));
        await flush_promises();

        const metas = sheet_meta(panel);
        expect(metas).toHaveLength(1);
        expect(metas[0].meta.sheets[0].rowCount).toBe(3);
        expect(close_spy).toHaveBeenCalledTimes(1);
    });

    it('CSV preview reuse ignores an old reload that completes after the panel is reused', async () => {
        const old_reload = deferred<Uint8Array>();
        const new_load = deferred<Uint8Array>();
        const close_spy = vi.spyOn(CsvDataSource.prototype, 'close');

        vscode_mock.__setStatImplementation(async () => ({ size: 100, mtime: 0 }));
        vscode_mock.__setReadFileImplementation(async (request_uri) => (
            request_uri.fsPath === '/tmp/old.csv' ? old_reload.promise : new_load.promise
        ));

        show_csv_preview(uri('/tmp/old.csv'), uri('/ext'), state_store(), view_column(vscode_mock.ViewColumn.Active));
        const panel = vscode_mock.__getPanels()[0];
        const old_reload_done = vscode_mock.__getWatchers()[0].__fireChange();

        show_csv_preview(uri('/tmp/new.csv'), uri('/ext'), state_store(), view_column(vscode_mock.ViewColumn.Active));
        await panel.__receive({ type: 'ready' });

        new_load.resolve(enc.encode('n\n1\n2\n'));
        await flush_promises();
        old_reload.resolve(enc.encode('old\n'));
        await old_reload_done;
        await flush_promises();

        const metas = sheet_meta(panel);
        expect(metas).toHaveLength(1);
        expect(metas[0].meta.sheets[0].rowCount).toBe(3);
        expect(meta_reloads(panel)).toHaveLength(0);
        expect(close_spy).toHaveBeenCalledTimes(1);
    });
});
