import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as vscode from 'vscode';
import { attach_viewer, csv_table_profile } from '../viewer-controller';
import { dispose_csv_preview, show_csv_preview } from '../csv-preview';
import { CsvDataSource } from '../data-source/csv-source';
import type { FileStateStore } from '../state';
import * as vscode_mock from './mocks/vscode';

/**
 * Drive the CSV-table lifecycle through the shared controller, mirroring the
 * old `open_csv_table` entry point: create a mock panel, attach the editable
 * CSV profile, and route disposal the way the custom-editor host does.
 */
function open_csv_table(file_uri: vscode.Uri): void {
    const panel = vscode_mock.window.createWebviewPanel('tableViewer.editor', 'table');
    const controller = attach_viewer(
        panel as unknown as Parameters<typeof attach_viewer>[0],
        file_uri,
        state_store(),
        csv_table_profile(),
    );
    panel.onDidDispose(() => controller.dispose());
}

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

        open_csv_table(uri('/tmp/race.csv'));
        const watcher = vscode_mock.__getWatchers()[0];
        const first_reload = watcher.__fireChange();
        const second_reload = watcher.__fireChange();

        newer.resolve(enc.encode('h\nn\n1\n2\n'));
        await second_reload;
        older.resolve(enc.encode('h\nold\n'));
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

        open_csv_table(uri('/tmp/race.csv'));
        const panel = vscode_mock.__getPanels()[0];
        const initial_ready = panel.__receive({ type: 'ready' });
        const reload_done = vscode_mock.__getWatchers()[0].__fireChange();

        reload.resolve(enc.encode('h\nn\n1\n2\n'));
        await reload_done;
        initial.resolve(enc.encode('h\nold\n'));
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

        open_csv_table(uri('/tmp/race.csv'));
        const panel = vscode_mock.__getPanels()[0];
        const watcher = vscode_mock.__getWatchers()[0];
        const pre_ready_done = watcher.__fireChange();

        pre_ready_reload.resolve(enc.encode('h\npre\n'));
        await pre_ready_done;
        panel.__messages.length = 0;

        const initial_ready = panel.__receive({ type: 'ready' });
        const post_ready_done = watcher.__fireChange();

        post_ready_reload.resolve(enc.encode('h\nn\n1\n2\n'));
        await post_ready_done;
        initial.resolve(enc.encode('h\nold\n'));
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

        open_csv_table(uri('/tmp/race.csv'));
        const panel = vscode_mock.__getPanels()[0];
        const initial_ready = panel.__receive({ type: 'ready' });

        panel.dispose();
        initial.resolve(enc.encode('h\nold\n'));
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

        newer.resolve(enc.encode('h\nn\n1\n2\n'));
        await second_reload;
        older.resolve(enc.encode('h\nold\n'));
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
        void panel.__receive({ type: 'ready' });
        const reload_done = vscode_mock.__getWatchers()[0].__fireChange();

        reload.resolve(enc.encode('h\nn\n1\n2\n'));
        await reload_done;
        initial.resolve(enc.encode('h\nold\n'));
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

        pre_ready_reload.resolve(enc.encode('h\npre\n'));
        await pre_ready_done;
        panel.__messages.length = 0;

        void panel.__receive({ type: 'ready' });
        const post_ready_done = watcher.__fireChange();

        post_ready_reload.resolve(enc.encode('h\nn\n1\n2\n'));
        await post_ready_done;
        initial.resolve(enc.encode('h\nold\n'));
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
        void panel.__receive({ type: 'ready' });

        show_csv_preview(uri('/tmp/new.csv'), uri('/ext'), state_store(), view_column(vscode_mock.ViewColumn.Active));
        void panel.__receive({ type: 'ready' });

        new_load.resolve(enc.encode('h\nn\n1\n2\n'));
        await flush_promises();
        old_load.resolve(enc.encode('h\nold\n'));
        await flush_promises();

        const metas = sheet_meta(panel);
        expect(metas).toHaveLength(1);
        expect(metas[0].meta.sheets[0].rowCount).toBe(3);
        expect(close_spy).toHaveBeenCalledTimes(1);
    });

    it('a save is not rolled back by an in-flight stale reload', async () => {
        // A watcher reload is in flight (awaiting its parse) when the user saves.
        // The save re-parses the just-written file and adopts it; when the older
        // reload finally resolves it must be discarded, not allowed to overwrite
        // the saved source with stale content.
        const stale = deferred<Uint8Array>();
        const close_spy = vi.spyOn(CsvDataSource.prototype, 'close');
        let call = 0;

        vscode_mock.__setStatImplementation(async () => ({ size: 100, mtime: 1 }));
        vscode_mock.__setReadFileImplementation(async () => {
            call++;
            if (call === 1) return enc.encode('h\na\n');          // initial ready (rowCount 1)
            if (call === 2) return stale.promise;        // in-flight reload (rowCount 3)
            return enc.encode('h\na\nb\n');                        // save's re-parse (rowCount 2)
        });

        open_csv_table(uri('/tmp/save.csv'));
        const panel = vscode_mock.__getPanels()[0];
        await panel.__receive({ type: 'ready' });

        const watcher = vscode_mock.__getWatchers()[0];
        const reload_done = watcher.__fireChange();      // starts the in-flight reload

        await panel.__receive({ type: 'saveCsv', edits: { '1:0': 'b' } });

        // The older reload resolves only after the save has adopted its result.
        stale.resolve(enc.encode('h\nx\ny\nz\n'));                  // rowCount 3
        await reload_done;

        const reloads = meta_reloads(panel);
        // The save's metaReload (rowCount 2) must stand; the stale reload's
        // rowCount-3 result must never be adopted.
        expect(reloads.some((r) => r.meta.sheets[0].rowCount === 3)).toBe(false);
        expect(reloads.some((r) => r.meta.sheets[0].rowCount === 2)).toBe(true);
        expect(close_spy).toHaveBeenCalled();
    });

    it('does not drop an external edit that lands right after a save', async () => {
        // A real external change immediately after a save must still reload —
        // ordering (reload_seq), not a wall-clock window, decides which parse
        // wins, so a legitimate edit within the old 2s suppress window isn't lost.
        let current_mtime = 1;
        let call = 0;
        vscode_mock.__setStatImplementation(async () => ({ size: 100, mtime: current_mtime }));
        vscode_mock.__setReadFileImplementation(async () => {
            call++;
            if (call === 1) return enc.encode('h\na\n');            // ready (rowCount 1)
            if (call === 2) return enc.encode('h\na\nb\n');         // save re-parse (rowCount 2)
            return enc.encode('h\np\nq\nr\ns\nt\n');                // external edit (rowCount 5)
        });

        open_csv_table(uri('/tmp/save.csv'));
        const panel = vscode_mock.__getPanels()[0];
        await panel.__receive({ type: 'ready' });

        await panel.__receive({ type: 'saveCsv', edits: { '1:0': 'b' } });

        // An external edit changes the file (new mtime) right after the save.
        current_mtime = 2;
        await vscode_mock.__getWatchers()[0].__fireChange();

        const reloads = meta_reloads(panel);
        expect(reloads.some((r) => r.meta.sheets[0].rowCount === 5)).toBe(true);
    });

    it('reports save success even when the post-write reload fails', async () => {
        // The write succeeded, so the bytes are on disk. If the follow-up
        // re-parse throws (transient read error / external delete in the TOCTOU
        // window), the save must still be reported as successful, not failed.
        let call = 0;
        vscode_mock.__setStatImplementation(async () => ({ size: 100, mtime: 1 }));
        vscode_mock.__setReadFileImplementation(async () => {
            call++;
            if (call === 1) return enc.encode('h\na\n'); // initial ready
            throw new Error('reload boom');           // save's re-parse fails
        });

        open_csv_table(uri('/tmp/save.csv'));
        const panel = vscode_mock.__getPanels()[0];
        await panel.__receive({ type: 'ready' });

        await panel.__receive({ type: 'saveCsv', edits: { '0:0': 'b' } });

        const results = panel.__messages.filter(
            (m): m is { type: string; success: boolean } => (
                typeof m === 'object' && m !== null && 'type' in m
                && (m as { type: string }).type === 'saveResult'
            ),
        );
        expect(results).toEqual([{ type: 'saveResult', success: true }]);
    });

    it('reports a save conflict cleanly even when the post-conflict reload fails', async () => {
        // An external change is detected (mtime differs), so the save is refused.
        // If the follow-up re-parse also throws, the user must see only the
        // conflict result — not a spurious generic "Failed to save" error.
        let call = 0;
        let mtime = 1;
        vscode_mock.__setStatImplementation(async () => ({ size: 100, mtime }));
        vscode_mock.__setReadFileImplementation(async () => {
            call++;
            if (call === 1) return enc.encode('h\na\n'); // initial ready (last_mtime = 1)
            throw new Error('reload boom');           // post-conflict re-parse fails
        });
        const error_spy = vi.spyOn(vscode_mock.window, 'showErrorMessage');

        open_csv_table(uri('/tmp/save.csv'));
        const panel = vscode_mock.__getPanels()[0];
        await panel.__receive({ type: 'ready' });

        // External change bumps the mtime, so handle_save sees a conflict.
        mtime = 2;
        await panel.__receive({ type: 'saveCsv', edits: { '0:0': 'b' } });

        const results = panel.__messages.filter(
            (m): m is { type: string; success: boolean } => (
                typeof m === 'object' && m !== null && 'type' in m
                && (m as { type: string }).type === 'saveResult'
            ),
        );
        expect(results).toEqual([{ type: 'saveResult', success: false }]);
        // Only the "modified externally" warning — no generic save-failure error.
        expect(error_spy).not.toHaveBeenCalled();
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
        void panel.__receive({ type: 'ready' });

        new_load.resolve(enc.encode('h\nn\n1\n2\n'));
        await flush_promises();
        old_reload.resolve(enc.encode('h\nold\n'));
        await old_reload_done;
        await flush_promises();

        const metas = sheet_meta(panel);
        expect(metas).toHaveLength(1);
        expect(metas[0].meta.sheets[0].rowCount).toBe(3);
        expect(meta_reloads(panel)).toHaveLength(0);
        expect(close_spy).toHaveBeenCalledTimes(1);
    });
});
