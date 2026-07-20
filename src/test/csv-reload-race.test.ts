import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as vscode from 'vscode';
import { attach_viewer, csv_table_profile } from '../viewer-controller';
import { dispose_csv_preview, show_csv_preview } from '../csv-preview';
import { CsvDataSource } from '../data-source/csv-source';
import type { DataSource } from '../data-source/interface';
import { acquire_file_coordinator } from '../file-coordinator';
import type { AuthorityFileStateStore } from '../state';
import { versioned_state_store } from './helpers/versioned-state-store';
import * as vscode_mock from './mocks/vscode';
import { with_in_memory_authority_transactions } from '../state-authority';
import type { WorkbookSnapshotIdentity } from '../viewer-snapshot';

/**
 * Drive the CSV-table lifecycle through the shared controller, mirroring the
 * old `open_csv_table` entry point: create a mock panel, attach the editable
 * CSV profile, and route disposal the way the custom-editor host does.
 */
function open_csv_table(
    file_uri: vscode.Uri,
    store: AuthorityFileStateStore = state_store(),
): void {
    const panel = vscode_mock.window.createWebviewPanel('tableViewer.editor', 'table');
    const controller = attach_viewer(
        panel as unknown as Parameters<typeof attach_viewer>[0],
        file_uri,
        store,
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
    // Coordinator adoption adds a short serialized authority-establishment hop.
    for (let i = 0; i < 20; i++) {
        await Promise.resolve();
    }
}

function state_store(): AuthorityFileStateStore {
    return with_in_memory_authority_transactions(versioned_state_store().store);
}

function uri(path: string): vscode.Uri {
    return vscode_mock.Uri.file(path) as unknown as vscode.Uri;
}

function view_column(column: number): vscode.ViewColumn {
    return column as vscode.ViewColumn;
}

interface CsvSnapshot {
    type: 'workbookSnapshot';
    snapshot: {
        presentation: 'initial' | 'refresh';
        reason: string;
        generation: number;
        sourceGeneration: number;
        previewMode?: boolean;
        configuration: { previewMode: boolean };
        capabilities: { csvEditable: boolean; csvEditingSupported: boolean };
        meta: { sheets: { rowCount: number }[] };
        state: Record<string, unknown>;
        identity: WorkbookSnapshotIdentity;
    };
}

function workbook_snapshots(panel: { __messages: unknown[] }): CsvSnapshot['snapshot'][] {
    return panel.__messages.flatMap((message) => (
        typeof message === 'object'
        && message !== null
        && 'type' in message
        && message.type === 'workbookSnapshot'
        && 'snapshot' in message
            ? [{
                ...(message as CsvSnapshot).snapshot,
                previewMode: (message as CsvSnapshot).snapshot.configuration.previewMode,
            }]
            : []
    ));
}

function refresh_snapshots(panel: { __messages: unknown[] }) {
    return workbook_snapshots(panel).filter((snapshot) => snapshot.presentation === 'refresh');
}

function initial_snapshots(panel: { __messages: unknown[] }) {
    return workbook_snapshots(panel).filter((snapshot) => snapshot.presentation === 'initial');
}

beforeEach(() => {
    dispose_csv_preview();
    for (const panel of vscode_mock.__getPanels()) panel.dispose();
    vi.restoreAllMocks();
    vscode_mock.__reset();
});

describe('CSV reload races', () => {
    it('uses only native metadata and resends an active source on a new ready epoch', async () => {
        let reads = 0;
        vscode_mock.__setStatImplementation(async () => ({ size: 20, mtime: 1 }));
        vscode_mock.__setReadFileImplementation(async () => {
            reads += 1;
            return enc.encode('h\na\n');
        });
        open_csv_table(uri('/tmp/native-only.csv'));
        const panel = vscode_mock.__getPanels()[0];

        await panel.__receive({ type: 'ready' });
        await flush_promises();
        const first = workbook_snapshots(panel).at(-1)!;
        await panel.__receive({ type: 'ready' });
        await flush_promises();
        const second = workbook_snapshots(panel).at(-1)!;

        expect(panel.__messages.some((message) => (
            typeof message === 'object'
            && message !== null
            && 'type' in message
            && ['sheetMeta', 'metaReload', 'metaReloadRecovery'].includes(String(message.type))
        ))).toBe(false);
        expect(second.identity).not.toEqual(first.identity);
        expect(second.generation).toBe(first.generation);
        expect(second.sourceGeneration).toBe(first.sourceGeneration);
        expect(reads).toBe(2);
    });

    it('requires an exact current snapshot ACK before CSV save', async () => {
        vscode_mock.__setStatImplementation(async () => ({ size: 20, mtime: 1 }));
        vscode_mock.__setReadFileImplementation(async () => enc.encode('h\na\n'));
        open_csv_table(uri('/tmp/ack-save.csv'));
        const panel = vscode_mock.__getPanels()[0];
        panel.__autoAckSnapshots = false;
        await panel.__receive({ type: 'ready' });
        await panel.__receive({ type: 'requestEditSession' });
        const delivered = workbook_snapshots(panel).at(-1)!;

        await panel.__receive({ type: 'saveCsv', edits: {} });
        expect(panel.__messages.at(-1)).toEqual({ type: 'saveResult', success: false });
        await panel.__receive({
            type: 'snapshotApplied',
            identity: { ...delivered.identity, deliveryId: 999 },
            disposition: 'applied',
        });
        await panel.__receive({ type: 'saveCsv', edits: {} });
        expect(panel.__messages.at(-1)).toEqual({ type: 'saveResult', success: false });

        await panel.__receive({
            type: 'snapshotApplied',
            identity: delivered.identity,
            disposition: 'duplicate',
        });
        await panel.__receive({ type: 'saveCsv', edits: {} });
        expect(panel.__messages.at(-1)).toEqual({ type: 'saveResult', success: true });
    });

    it('mock event disposables unregister handlers', async () => {
        let calls = 0;
        const watcher = vscode_mock.workspace.createFileSystemWatcher();
        const disposable = watcher.onDidChange(() => { calls++; });

        disposable.dispose();
        await watcher.__fireChange();

        expect(calls).toBe(0);
    });

    it('shares one watcher while each panel refreshes independently', async () => {
        const file_path = '/tmp/shared-watchers.csv';
        let reads = 0;
        vscode_mock.__setStatImplementation(async () => ({ size: 20, mtime: 1 }));
        vscode_mock.__setReadFileImplementation(async () => {
            reads += 1;
            return enc.encode('h\na\n');
        });

        open_csv_table(uri(file_path));
        open_csv_table(uri(file_path));
        const panels = vscode_mock.__getPanels();
        await panels[0].__receive({ type: 'ready' });
        await panels[1].__receive({ type: 'ready' });

        const watchers = vscode_mock.__getActiveWatchers();
        expect(watchers).toHaveLength(1);
        const authority = acquire_file_coordinator(file_path);
        expect(authority.authority()).toMatchObject({
            physicalRevision: 1,
            projectionRevision: 0,
            authorityRevision: 1,
        });

        const reads_before_refresh = reads;
        await watchers[0].__fireChange();
        expect(reads - reads_before_refresh).toBe(4);
        expect(authority.authority()).toMatchObject({
            physicalRevision: 1,
            projectionRevision: 0,
            authorityRevision: 1,
        });

        panels[0].dispose();
        expect(vscode_mock.__getActiveWatchers()).toHaveLength(1);
        panels[1].dispose();
        authority.dispose();
        expect(vscode_mock.__getActiveWatchers()).toHaveLength(0);
    });

    it('shares a watcher between preview and table while building separate sources', async () => {
        let reads = 0;
        const file_path = '/tmp/preview-table-shared.csv';
        vscode_mock.__setStatImplementation(async () => ({ size: 20, mtime: 1 }));
        vscode_mock.__setReadFileImplementation(async () => {
            reads += 1;
            return enc.encode('h\na\n');
        });

        show_csv_preview(
            uri(file_path),
            uri('/ext'),
            state_store(),
            view_column(vscode_mock.ViewColumn.Active),
        );
        open_csv_table(uri(file_path));
        const panels = vscode_mock.__getPanels();
        await panels[0].__receive({ type: 'ready' });
        await panels[1].__receive({ type: 'ready' });
        expect(vscode_mock.__getActiveWatchers()).toHaveLength(1);

        const reads_before_refresh = reads;
        await vscode_mock.__getActiveWatchers()[0].__fireChange();
        expect(reads - reads_before_refresh).toBe(4);
    });

    it('re-adopts a shared same-digest event only for an unacknowledged panel', async () => {
        vscode_mock.__setStatImplementation(async () => ({ size: 20, mtime: 1 }));
        vscode_mock.__setReadFileImplementation(async () => enc.encode('h\na\n'));

        open_csv_table(uri('/tmp/shared-ack.csv'));
        open_csv_table(uri('/tmp/shared-ack.csv'));
        const [acknowledged, unacknowledged] = vscode_mock.__getPanels();
        unacknowledged.__autoAckSnapshots = false;
        await acknowledged.__receive({ type: 'ready' });
        await unacknowledged.__receive({ type: 'ready' });
        const unacknowledged_initial = workbook_snapshots(unacknowledged).at(-1)!;

        await vscode_mock.__getActiveWatchers()[0].__fireChange();

        expect(refresh_snapshots(acknowledged)).toHaveLength(0);
        const recovered = workbook_snapshots(unacknowledged).at(-1)!;
        expect(recovered.sourceGeneration).toBeGreaterThan(
            unacknowledged_initial.sourceGeneration,
        );
    });

    it('coalesces delete-create-change into one panel-local build per subscriber', async () => {
        let reads = 0;
        vscode_mock.__setStatImplementation(async () => ({ size: 20, mtime: 1 }));
        vscode_mock.__setReadFileImplementation(async () => {
            reads += 1;
            return enc.encode('h\na\n');
        });

        open_csv_table(uri('/tmp/coalesced-shared.csv'));
        open_csv_table(uri('/tmp/coalesced-shared.csv'));
        const panels = vscode_mock.__getPanels();
        await panels[0].__receive({ type: 'ready' });
        await panels[1].__receive({ type: 'ready' });
        const reads_before_refresh = reads;
        const watcher = vscode_mock.__getActiveWatchers()[0];

        await Promise.all([
            watcher.__fireDelete(),
            watcher.__fireCreate(),
            watcher.__fireChange(),
        ]);

        expect(reads - reads_before_refresh).toBe(4);
        expect(refresh_snapshots(panels[0])).toHaveLength(0);
        expect(refresh_snapshots(panels[1])).toHaveLength(0);
    });

    it('lets another panel finish when one shared-event parser fails', async () => {
        let bytes = enc.encode('h\na\n');
        let fail_first_panel = false;
        vscode_mock.__setStatImplementation(async () => ({ size: bytes.byteLength, mtime: 1 }));
        vscode_mock.__setReadFileImplementation(async () => bytes);
        const base_profile = csv_table_profile();
        const failing_profile = {
            ...base_profile,
            async build_source(raw: Uint8Array, file_path: string, state: Parameters<typeof base_profile.build_source>[2]) {
                if (fail_first_panel) throw new Error('panel parser failed');
                return base_profile.build_source(raw, file_path, state);
            },
        };
        const first = vscode_mock.window.createWebviewPanel('tableViewer.editor', 'first');
        const second = vscode_mock.window.createWebviewPanel('tableViewer.editor', 'second');
        const first_controller = attach_viewer(
            first as unknown as Parameters<typeof attach_viewer>[0],
            uri('/tmp/shared-parser.csv'),
            state_store(),
            failing_profile,
        );
        const second_controller = attach_viewer(
            second as unknown as Parameters<typeof attach_viewer>[0],
            uri('/tmp/shared-parser.csv'),
            state_store(),
            csv_table_profile(),
        );
        await first.__receive({ type: 'ready' });
        await second.__receive({ type: 'ready' });
        fail_first_panel = true;
        bytes = enc.encode('h\na\nb\n');

        await vscode_mock.__getActiveWatchers()[0].__fireChange();
        await vi.waitFor(() => expect(refresh_snapshots(second)).toHaveLength(1));
        expect(refresh_snapshots(first)).toHaveLength(0);

        first_controller.dispose();
        second_controller.dispose();
    });

    it('lets a newer episode pass a stalled panel load without blocking peers', async () => {
        let bytes = enc.encode('h\na\n');
        let mtime = 1;
        let builds = 0;
        const stalled = deferred<DataSource>();
        const stalled_started = deferred<DataSource>();
        vscode_mock.__setStatImplementation(async () => ({
            size: bytes.byteLength,
            mtime,
        }));
        vscode_mock.__setReadFileImplementation(async () => bytes);
        const base_profile = csv_table_profile();
        const stalling_profile = {
            ...base_profile,
            async build_source(raw: Uint8Array, file_path: string, state: Parameters<typeof base_profile.build_source>[2]) {
                builds += 1;
                const built = await base_profile.build_source(raw, file_path, state);
                if (builds === 2) {
                    stalled_started.resolve(built);
                    return stalled.promise;
                }
                return built;
            },
        };
        const stalled_panel = vscode_mock.window.createWebviewPanel('tableViewer.editor', 'stalled');
        const healthy_panel = vscode_mock.window.createWebviewPanel('tableViewer.editor', 'healthy');
        const stalled_controller = attach_viewer(
            stalled_panel as unknown as Parameters<typeof attach_viewer>[0],
            uri('/tmp/stalled-shared.csv'),
            state_store(),
            stalling_profile,
        );
        const healthy_controller = attach_viewer(
            healthy_panel as unknown as Parameters<typeof attach_viewer>[0],
            uri('/tmp/stalled-shared.csv'),
            state_store(),
            csv_table_profile(),
        );
        await stalled_panel.__receive({ type: 'ready' });
        await healthy_panel.__receive({ type: 'ready' });
        const watcher = vscode_mock.__getActiveWatchers()[0];

        bytes = enc.encode('h\na\nb\n');
        mtime = 2;
        await watcher.__fireChange();
        const stale_source = await stalled_started.promise;
        await vi.waitFor(() => expect(refresh_snapshots(healthy_panel)).toHaveLength(1));

        bytes = enc.encode('h\na\nb\nc\n');
        mtime = 3;
        await watcher.__fireChange();
        await vi.waitFor(() => expect(refresh_snapshots(healthy_panel)).toHaveLength(2));
        await vi.waitFor(() => expect(refresh_snapshots(stalled_panel)).toHaveLength(1));

        const stale_close = vi.spyOn(stale_source, 'close');
        stalled.resolve(stale_source);
        await flush_promises();
        expect(stale_close).toHaveBeenCalledTimes(1);
        expect(refresh_snapshots(stalled_panel)).toHaveLength(1);

        stalled_controller.dispose();
        healthy_controller.dispose();
    });

    it('retains the adopted view across delete retries and recovers on create', async () => {
        let deleted = false;
        let bytes = enc.encode('h\na\n');
        vscode_mock.__setStatImplementation(async () => {
            if (deleted) throw Object.assign(new Error('not found'), { code: 'ENOENT' });
            return { size: bytes.byteLength, mtime: 1 };
        });
        vscode_mock.__setReadFileImplementation(async () => bytes);
        open_csv_table(uri('/tmp/delete-create.csv'));
        const panel = vscode_mock.__getPanels()[0];
        await panel.__receive({ type: 'ready' });
        const error_spy = vi.spyOn(vscode_mock.window, 'showErrorMessage');
        vi.useFakeTimers();
        deleted = true;

        await vscode_mock.__getActiveWatchers()[0].__fireDelete();
        await vi.advanceTimersByTimeAsync(500);

        expect(refresh_snapshots(panel)).toHaveLength(0);
        expect(error_spy).toHaveBeenCalledTimes(1);

        deleted = false;
        bytes = enc.encode('h\na\nb\n');
        await vscode_mock.__getActiveWatchers()[0].__fireCreate();
        await vi.waitFor(() => expect(refresh_snapshots(panel)).toHaveLength(1));
        expect(refresh_snapshots(panel)[0].meta.sheets[0].rowCount).toBe(2);
        vi.useRealTimers();
    });

    it('closes a same-digest dedup candidate without transferring it', async () => {
        vscode_mock.__setStatImplementation(async () => ({ size: 20, mtime: 1 }));
        vscode_mock.__setReadFileImplementation(async () => enc.encode('h\na\n'));
        const close_spy = vi.spyOn(CsvDataSource.prototype, 'close');

        open_csv_table(uri('/tmp/dedup-ownership.csv'));
        const panel = vscode_mock.__getPanels()[0];
        await panel.__receive({ type: 'ready' });
        await vscode_mock.__getWatchers()[0].__fireChange();

        expect(close_spy).toHaveBeenCalledTimes(1);
        expect(refresh_snapshots(panel)).toHaveLength(0);
        panel.dispose();
        expect(close_spy).toHaveBeenCalledTimes(2);
    });

    it('delivers the latest durable panel state after physical finalization', async () => {
        const file_path = '/tmp/receipt-state.csv';
        const versioned = versioned_state_store({
            pendingEdits: { '0:0': 'committed' },
        });
        const base = with_in_memory_authority_transactions(versioned.store);
        const store: AuthorityFileStateStore = {
            ...base,
            async finalize_authority_transaction(path, id) {
                const finalized = await base.finalize_authority_transaction(path, id);
                if (finalized.type === 'finalized') {
                    await versioned.store.compare_and_set(
                        path,
                        finalized.snapshot.revision,
                        { pendingEdits: { '0:0': 'later' } },
                    );
                }
                return finalized;
            },
        };
        vscode_mock.__setStatImplementation(async () => ({ size: 20, mtime: 1 }));
        vscode_mock.__setReadFileImplementation(async () => enc.encode('h\na\n'));

        open_csv_table(uri(file_path), store);
        const panel = vscode_mock.__getPanels()[0];
        await panel.__receive({ type: 'ready' });

        expect(initial_snapshots(panel)[0]).toMatchObject({
            state: { pendingEdits: { '0:0': 'later' } },
        });
        expect(versioned.get_state(file_path).pendingEdits).toEqual({ '0:0': 'later' });
    });

    it('adopts a candidate reconciled from an exact committed finalization', async () => {
        const versioned = versioned_state_store();
        const base = with_in_memory_authority_transactions(versioned.store);
        const store: AuthorityFileStateStore = {
            ...base,
            async finalize_authority_transaction(path, id) {
                await base.finalize_authority_transaction(path, id);
                throw new Error('reported after commit');
            },
        };
        const close_spy = vi.spyOn(CsvDataSource.prototype, 'close');
        vscode_mock.__setStatImplementation(async () => ({ size: 20, mtime: 1 }));
        vscode_mock.__setReadFileImplementation(async () => enc.encode('h\na\n'));

        open_csv_table(uri('/tmp/reconciled-commit.csv'), store);
        const panel = vscode_mock.__getPanels()[0];
        await panel.__receive({ type: 'ready' });

        expect(initial_snapshots(panel)).toHaveLength(1);
        expect(close_spy).not.toHaveBeenCalled();
        panel.dispose();
        expect(close_spy).toHaveBeenCalledTimes(1);
    });

    it('never transfers a candidate after advanced finalization reconciliation', async () => {
        const versioned = versioned_state_store();
        const base = with_in_memory_authority_transactions(versioned.store);
        const store: AuthorityFileStateStore = {
            ...base,
            async finalize_authority_transaction(path, id) {
                const local = await base.finalize_authority_transaction(path, id);
                if (local.type !== 'finalized') return local;
                await base.stage_authority_transaction(path, {
                    id: 'external-advance',
                    kind: 'physical',
                    ordinal: 999,
                    expectedStateRevision: local.snapshot.revision,
                    expectedCommitSequence: local.authority.commitSequence,
                    physicalDigest: 'external-digest',
                });
                await base.finalize_authority_transaction(path, 'external-advance');
                throw new Error('ambiguous finalization');
            },
        };
        const close_spy = vi.spyOn(CsvDataSource.prototype, 'close');
        vscode_mock.__setStatImplementation(async () => ({ size: 20, mtime: 1 }));
        vscode_mock.__setReadFileImplementation(async () => enc.encode('h\na\n'));

        open_csv_table(uri('/tmp/advanced-finalization.csv'), store);
        const panel = vscode_mock.__getPanels()[0];
        await panel.__receive({ type: 'ready' });

        expect(initial_snapshots(panel)).toHaveLength(0);
        expect(refresh_snapshots(panel)).toHaveLength(0);
        expect(close_spy).toHaveBeenCalledTimes(1);
        panel.dispose();
        expect(close_spy).toHaveBeenCalledTimes(1);
    });

    it('observes authority advancement reported by staging without retrying forever', async () => {
        const versioned = versioned_state_store();
        const base = with_in_memory_authority_transactions(versioned.store);
        let advanced = false;
        const store: AuthorityFileStateStore = {
            ...base,
            async stage_authority_transaction(path, input) {
                if (!advanced) {
                    advanced = true;
                    await base.stage_authority_transaction(path, {
                        id: 'external-stage-advance',
                        kind: 'physical',
                        ordinal: 999,
                        expectedStateRevision: input.expectedStateRevision,
                        expectedCommitSequence: input.expectedCommitSequence,
                        physicalDigest: 'external-digest',
                    });
                    await base.finalize_authority_transaction(path, 'external-stage-advance');
                }
                return base.stage_authority_transaction(path, input);
            },
        };
        const close_spy = vi.spyOn(CsvDataSource.prototype, 'close');
        vscode_mock.__setStatImplementation(async () => ({ size: 20, mtime: 1 }));
        vscode_mock.__setReadFileImplementation(async () => enc.encode('h\na\n'));

        open_csv_table(uri('/tmp/stage-authority-advance.csv'), store);
        const panel = vscode_mock.__getPanels()[0];
        await panel.__receive({ type: 'ready' });

        expect(initial_snapshots(panel)).toHaveLength(0);
        expect(close_spy).toHaveBeenCalledTimes(1);
        panel.dispose();
    });

    it('observes authority advancement returned by finalization without a receipt', async () => {
        const versioned = versioned_state_store();
        const base = with_in_memory_authority_transactions(versioned.store);
        let advanced = false;
        const store: AuthorityFileStateStore = {
            ...base,
            async finalize_authority_transaction(path, id) {
                if (!advanced) {
                    advanced = true;
                    const snapshot = await base.read(path);
                    const authority = await base.read_authority(path);
                    await base.stage_authority_transaction(path, {
                        id: 'external-finalize-advance',
                        kind: 'physical',
                        ordinal: 999,
                        expectedStateRevision: snapshot.revision,
                        expectedCommitSequence: authority.commitSequence,
                        physicalDigest: 'external-digest',
                    });
                    await base.finalize_authority_transaction(
                        path,
                        'external-finalize-advance',
                    );
                }
                return base.finalize_authority_transaction(path, id);
            },
        };
        const close_spy = vi.spyOn(CsvDataSource.prototype, 'close');
        vscode_mock.__setStatImplementation(async () => ({ size: 20, mtime: 1 }));
        vscode_mock.__setReadFileImplementation(async () => enc.encode('h\na\n'));

        open_csv_table(uri('/tmp/finalize-authority-advance.csv'), store);
        const panel = vscode_mock.__getPanels()[0];
        await panel.__receive({ type: 'ready' });

        expect(initial_snapshots(panel)).toHaveLength(0);
        expect(close_spy).toHaveBeenCalledTimes(1);
        panel.dispose();
    });

    it('CSV table ignores an older reload and sends an initial snapshot when the newer reload is first delivery', async () => {
        const older = deferred<Uint8Array>();
        const newer = deferred<Uint8Array>();
        // Each candidate is read once to parse and once immediately before
        // adoption. The newer candidate completes verification first.
        const reads = [older, newer, newer, older];
        const close_spy = vi.spyOn(CsvDataSource.prototype, 'close');
        let mtime = 0;

        vscode_mock.__setStatImplementation(async () => ({ size: 100, mtime: Math.min(++mtime, 2) }));
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
        expect(workbook_snapshots(panel)).toHaveLength(0);
        await panel.__receive({ type: 'ready' });
        const metas = initial_snapshots(panel);
        expect(metas).toHaveLength(1);
        expect(metas[0].meta.sheets[0].rowCount).toBe(3);
        expect(refresh_snapshots(panel)).toHaveLength(0);
        expect(close_spy).toHaveBeenCalledTimes(1);
    });

    it('retains candidate ownership when replacing the previous source throws', async () => {
        let current = enc.encode('h\na\n');
        vscode_mock.__setStatImplementation(async () => ({ size: 20, mtime: 1 }));
        vscode_mock.__setReadFileImplementation(async () => current);
        const close_spy = vi.spyOn(CsvDataSource.prototype, 'close');

        open_csv_table(uri('/tmp/adoption-close-throw.csv'));
        const panel = vscode_mock.__getPanels()[0];
        await panel.__receive({ type: 'ready' });
        current = enc.encode('h\nb\n');
        close_spy.mockImplementationOnce(() => { throw new Error('old close failed'); });

        await vscode_mock.__getWatchers()[0].__fireChange();

        // Installation and transfer are confirmed before old-source cleanup. The
        // The new adoption is installed before old-source cleanup; its snapshot
        // may already be posted even when closing the old source throws.
        expect(close_spy).toHaveBeenCalledTimes(1);
        expect(refresh_snapshots(panel)).toHaveLength(1);
        panel.dispose();
        expect(close_spy).toHaveBeenCalledTimes(2);
    });

    it('keeps transferred ownership unambiguous during reentrant panel disposal', async () => {
        let current = enc.encode('h\na\n');
        vscode_mock.__setStatImplementation(async () => ({ size: 20, mtime: 1 }));
        vscode_mock.__setReadFileImplementation(async () => current);
        const close_spy = vi.spyOn(CsvDataSource.prototype, 'close');

        open_csv_table(uri('/tmp/reentrant-adoption-disposal.csv'));
        const panel = vscode_mock.__getPanels()[0];
        await panel.__receive({ type: 'ready' });
        current = enc.encode('h\nb\n');
        close_spy.mockImplementationOnce(() => { panel.dispose(); });

        await vscode_mock.__getWatchers()[0].__fireChange();

        expect(refresh_snapshots(panel)).toHaveLength(1);
        expect(close_spy).toHaveBeenCalledTimes(2);
        panel.dispose();
        expect(close_spy).toHaveBeenCalledTimes(2);
    });

    it('does not install an older commit after a newer reload supersedes finalization', async () => {
        const versioned = versioned_state_store();
        const base = with_in_memory_authority_transactions(versioned.store);
        let finalize_calls = 0;
        let mark_old_finalizing!: () => void;
        const old_finalizing = new Promise<void>((resolve) => {
            mark_old_finalizing = resolve;
        });
        let release_old!: () => void;
        const old_gate = new Promise<void>((resolve) => { release_old = resolve; });
        const store: AuthorityFileStateStore = {
            ...base,
            async finalize_authority_transaction(path, id) {
                finalize_calls += 1;
                if (finalize_calls === 2) {
                    mark_old_finalizing();
                    await old_gate;
                }
                return base.finalize_authority_transaction(path, id);
            },
        };
        let reads = 0;
        vscode_mock.__setStatImplementation(async () => ({ size: 20, mtime: 1 }));
        vscode_mock.__setReadFileImplementation(async () => {
            reads += 1;
            if (reads <= 2) return enc.encode('h\noriginal\n');
            if (reads <= 4) return enc.encode('h\nstale\nextra\n');
            throw new Error('newer reload failed');
        });
        const close_spy = vi.spyOn(CsvDataSource.prototype, 'close');

        open_csv_table(uri('/tmp/finalization-supersession.csv'), store);
        const panel = vscode_mock.__getPanels()[0];
        await panel.__receive({ type: 'ready' });
        const initial = initial_snapshots(panel)[0] as unknown as {
            generation: number;
            sourceGeneration: number;
        };
        const watcher = vscode_mock.__getWatchers()[0];
        const old_reload = watcher.__fireChange();
        await old_finalizing;
        await watcher.__fireChange();
        release_old();
        await old_reload;
        await flush_promises();

        expect(refresh_snapshots(panel)).toHaveLength(0);
        expect(close_spy).toHaveBeenCalledTimes(1);
        await panel.__receive({
            type: 'requestRows',
            sheetIndex: 0,
            startRow: 0,
            count: 1,
            requestId: 'retained-source',
            generation: initial.generation,
            sourceGeneration: initial.sourceGeneration,
        });
        expect(panel.__messages).toContainEqual(expect.objectContaining({
            type: 'rowData',
            requestId: 'retained-source',
            rows: [[expect.objectContaining({ raw: 'original' })]],
        }));
        panel.dispose();
        expect(close_spy).toHaveBeenCalledTimes(2);
    });

    it('reloads changed bytes even when stat metadata is unchanged', async () => {
        let reads = 0;
        vscode_mock.__setStatImplementation(async () => ({ size: 100, mtime: 1 }));
        vscode_mock.__setReadFileImplementation(async () => {
            reads += 1;
            return reads <= 2
                ? enc.encode('h\na\n')
                : enc.encode('h\nb\nc\n');
        });

        open_csv_table(uri('/tmp/same-stat.csv'));
        const panel = vscode_mock.__getPanels()[0];
        await panel.__receive({ type: 'ready' });
        await vscode_mock.__getWatchers()[0].__fireChange();

        expect(refresh_snapshots(panel).at(-1)?.meta.sheets[0].rowCount).toBe(2);
    });

    it('ignores a delayed initial post after a newer initial adoption fails delivery', async () => {
        let current = enc.encode('h\na\n');
        vscode_mock.__setStatImplementation(async () => ({ size: 100, mtime: 1 }));
        vscode_mock.__setReadFileImplementation(async () => current);
        open_csv_table(uri('/tmp/delayed-initial-delivery.csv'));
        const panel = vscode_mock.__getPanels()[0];
        const original_post = panel.webview.postMessage.bind(panel.webview);
        const older_post = deferred<boolean>();
        const older_started = deferred<void>();
        const attempts: Array<{ generation: number; sourceGeneration: number }> = [];
        vi.spyOn(panel.webview, 'postMessage').mockImplementation(async (message: any) => {
            if (message?.type === 'workbookSnapshot') {
                attempts.push({
                    generation: message.snapshot.generation,
                    sourceGeneration: message.snapshot.sourceGeneration,
                });
                if (attempts.length === 1) {
                    older_started.resolve(undefined);
                    return older_post.promise;
                }
                if (attempts.length === 2) return false;
            }
            return original_post(message);
        });

        const ready = panel.__receive({ type: 'ready' });
        await older_started.promise;
        current = enc.encode('h\nb\n');
        const watcher = vscode_mock.__getWatchers()[0];
        await watcher.__fireChange();
        older_post.resolve(true);
        await ready;

        // The successful A post cannot make B initial/delivered. A same-digest B
        // event must re-adopt and retry the initial snapshot rather than
        // deduplicating or switching prematurely to a refresh presentation.
        await watcher.__fireChange();
        expect(attempts).toEqual([
            { generation: 1, sourceGeneration: 1 },
            { generation: 1, sourceGeneration: 1 },
            { generation: 2, sourceGeneration: 2 },
        ]);
        expect(initial_snapshots(panel).at(-1)).toMatchObject({
            generation: 2,
            sourceGeneration: 2,
        });
        expect(refresh_snapshots(panel)).toHaveLength(0);
    });

    it('counts the source re-adoption, not the failed initial metadata post', async () => {
        vi.useFakeTimers();
        vscode_mock.__setStatImplementation(async () => ({ size: 100, mtime: 1 }));
        vscode_mock.__setReadFileImplementation(async () => enc.encode('h\na\n'));
        open_csv_table(uri('/tmp/initial-delivery.csv'));
        const panel = vscode_mock.__getPanels()[0];
        const original_post = panel.webview.postMessage.bind(panel.webview);
        let initial_snapshots_attempts = 0;
        vi.spyOn(panel.webview, 'postMessage').mockImplementation(async (message: unknown) => {
            if (
                typeof message === 'object'
                && message !== null
                && 'type' in message
                && message.type === 'workbookSnapshot'
            ) {
                initial_snapshots_attempts += 1;
                if (initial_snapshots_attempts === 1) return false;
            }
            return original_post(message);
        });

        await panel.__receive({ type: 'ready' });
        await vi.advanceTimersByTimeAsync(50);

        expect(initial_snapshots_attempts).toBe(2);
        expect(initial_snapshots(panel)).toMatchObject([{
            sourceGeneration: 1,
            generation: 1,
        }]);
        await vscode_mock.__getWatchers()[0].__fireChange();
        expect(initial_snapshots_attempts).toBe(2);
        vi.useRealTimers();
    });

    it('does not credit a delayed older post to a newer failed adoption', async () => {
        let current = enc.encode('h\ninitial\n');
        vscode_mock.__setStatImplementation(async () => ({ size: 100, mtime: 1 }));
        vscode_mock.__setReadFileImplementation(async () => current);
        open_csv_table(uri('/tmp/delayed-delivery.csv'));
        const panel = vscode_mock.__getPanels()[0];
        await panel.__receive({ type: 'ready' });

        const original_post = panel.webview.postMessage.bind(panel.webview);
        const older_post = deferred<boolean>();
        const older_started = deferred<void>();
        const attempts: Array<{ generation: number; sourceGeneration: number }> = [];
        vi.spyOn(panel.webview, 'postMessage').mockImplementation(async (message: any) => {
            if (message?.type === 'workbookSnapshot') {
                attempts.push({
                    generation: message.snapshot.generation,
                    sourceGeneration: message.snapshot.sourceGeneration,
                });
                if (attempts.length === 1) {
                    older_started.resolve(undefined);
                    return older_post.promise;
                }
                if (attempts.length === 2) return false;
            }
            return original_post(message);
        });

        const watcher = vscode_mock.__getWatchers()[0];
        current = enc.encode('h\na\n');
        const older_reload = watcher.__fireChange();
        await older_started.promise;

        current = enc.encode('h\nb\n');
        await watcher.__fireChange();
        older_post.resolve(true);
        await older_reload;

        await panel.__receive({ type: 'saveCsv', edits: {} });
        expect(panel.__messages.at(-1)).toEqual({ type: 'saveResult', success: false });

        // The same B digest must not deduplicate: only a B metadata post can mark
        // this adoption delivered. The third event therefore reparses and posts.
        await watcher.__fireChange();
        expect(attempts).toEqual([
            { generation: 2, sourceGeneration: 2 },
            { generation: 2, sourceGeneration: 2 },
            { generation: 3, sourceGeneration: 3 },
        ]);
        expect(refresh_snapshots(panel).at(-1)).toMatchObject({
            generation: 3,
            sourceGeneration: 3,
            meta: { sheets: [{ rowCount: 1 }] },
        });
    });

    it('does not deduplicate a same-digest watcher after failed reload delivery', async () => {
        const close_spy = vi.spyOn(CsvDataSource.prototype, 'close');
        let current = enc.encode('h\na\n');
        vscode_mock.__setStatImplementation(async () => ({ size: 100, mtime: 1 }));
        vscode_mock.__setReadFileImplementation(async () => current);
        open_csv_table(uri('/tmp/reload-delivery.csv'));
        const panel = vscode_mock.__getPanels()[0];
        await panel.__receive({ type: 'ready' });
        current = enc.encode('h\nb\nc\n');
        const original_post = panel.webview.postMessage.bind(panel.webview);
        let reload_attempts = 0;
        vi.spyOn(panel.webview, 'postMessage').mockImplementation(async (message: unknown) => {
            if (
                typeof message === 'object'
                && message !== null
                && 'type' in message
                && message.type === 'workbookSnapshot'
            ) {
                reload_attempts += 1;
                if (reload_attempts === 1) return false;
            }
            return original_post(message);
        });

        const watcher = vscode_mock.__getWatchers()[0];
        await watcher.__fireChange();
        await watcher.__fireChange();

        expect(reload_attempts).toBe(2);
        expect(refresh_snapshots(panel)).toMatchObject([{
            sourceGeneration: 2,
            generation: 2,
            meta: { sheets: [{ rowCount: 2 }] },
        }]);
        expect(close_spy).toHaveBeenCalledTimes(2);
    });

    it('rejects stale same-stat parsed bytes and retries the current snapshot', async () => {
        vi.useFakeTimers();
        let reads = 0;
        vscode_mock.__setStatImplementation(async () => ({ size: 100, mtime: 1 }));
        vscode_mock.__setReadFileImplementation(async () => {
            reads += 1;
            if (reads <= 2) return enc.encode('h\na\n');
            if (reads === 3) return enc.encode('h\nstale\n');
            return enc.encode('h\n1\n2\n3\n');
        });
        open_csv_table(uri('/tmp/same-stat-snapshot.csv'));
        const panel = vscode_mock.__getPanels()[0];
        await panel.__receive({ type: 'ready' });

        await vscode_mock.__getWatchers()[0].__fireChange();
        await vi.advanceTimersByTimeAsync(50);

        expect(refresh_snapshots(panel)).toMatchObject([{
            meta: { sheets: [{ rowCount: 3 }] },
        }]);
        vi.useRealTimers();
    });

    it('shares one retry budget across locked and unstable reload failures', async () => {
        vi.useFakeTimers();
        vscode_mock.__setStatImplementation(async () => ({ size: 100, mtime: 1 }));
        vscode_mock.__setReadFileImplementation(async () => enc.encode('h\na\n'));
        open_csv_table(uri('/tmp/mixed-retry.csv'));
        const panel = vscode_mock.__getPanels()[0];
        await panel.__receive({ type: 'ready' });

        let stat_calls = 0;
        vscode_mock.__setStatImplementation(async () => {
            stat_calls += 1;
            if (stat_calls === 1) {
                throw Object.assign(new Error('busy'), { code: 'EBUSY' });
            }
            if (stat_calls === 4) {
                throw Object.assign(new Error('denied'), { code: 'EPERM' });
            }
            return { size: 100, mtime: stat_calls };
        });

        await vscode_mock.__getWatchers()[0].__fireChange();
        await vi.advanceTimersByTimeAsync(500);

        expect(stat_calls).toBe(6);
        expect(refresh_snapshots(panel)).toHaveLength(0);
        vi.useRealTimers();
    });

    it('closes a parsed candidate when final snapshot verification throws', async () => {
        let reads = 0;
        vscode_mock.__setStatImplementation(async () => ({ size: 100, mtime: 1 }));
        vscode_mock.__setReadFileImplementation(async () => {
            reads += 1;
            if (reads <= 2) return enc.encode('h\na\n');
            if (reads === 3) return enc.encode('h\nb\n');
            throw Object.assign(new Error('busy'), { code: 'EBUSY' });
        });
        const close_spy = vi.spyOn(CsvDataSource.prototype, 'close');
        open_csv_table(uri('/tmp/verification-cleanup.csv'));
        const panel = vscode_mock.__getPanels()[0];
        await panel.__receive({ type: 'ready' });

        await vscode_mock.__getWatchers()[0].__fireChange();

        expect(close_spy).toHaveBeenCalledTimes(1);
        expect(refresh_snapshots(panel)).toHaveLength(0);
    });

    it('retries transient locked-file reload failures', async () => {
        vi.useFakeTimers();
        vscode_mock.__setStatImplementation(async () => ({ size: 100, mtime: 1 }));
        vscode_mock.__setReadFileImplementation(async () => enc.encode('h\na\n'));
        open_csv_table(uri('/tmp/locked-retry.csv'));
        const panel = vscode_mock.__getPanels()[0];
        await panel.__receive({ type: 'ready' });

        let attempts = 0;
        vscode_mock.__setStatImplementation(async () => {
            attempts += 1;
            if (attempts <= 2) {
                throw Object.assign(new Error('locked'), { code: 'EBUSY' });
            }
            return { size: 100, mtime: 2 };
        });
        vscode_mock.__setReadFileImplementation(async () => enc.encode('h\nb\nc\n'));

        await vscode_mock.__getWatchers()[0].__fireChange();
        await vi.advanceTimersByTimeAsync(50);
        await vi.advanceTimersByTimeAsync(50);

        expect(attempts).toBeGreaterThanOrEqual(3);
        expect(refresh_snapshots(panel).at(-1)?.meta.sheets[0].rowCount).toBe(2);
        vi.useRealTimers();
    });

    it('bounds retries for continuously unstable file snapshots', async () => {
        vi.useFakeTimers();
        let reads = 0;
        vscode_mock.__setStatImplementation(async () => ({ size: 100, mtime: 1 }));
        vscode_mock.__setReadFileImplementation(async () => {
            reads += 1;
            return enc.encode('h\na\n');
        });
        open_csv_table(uri('/tmp/unstable-retry.csv'));
        const panel = vscode_mock.__getPanels()[0];
        await panel.__receive({ type: 'ready' });

        let mtime = 1;
        vscode_mock.__setStatImplementation(async () => ({
            size: 100,
            mtime: ++mtime,
        }));
        await vscode_mock.__getWatchers()[0].__fireChange();
        await vi.advanceTimersByTimeAsync(200);
        vi.useRealTimers();

        // Initial parse+verification, then four bounded watcher attempts that
        // are rejected by the first validation stat before another read.
        expect(reads).toBe(6);
        expect(refresh_snapshots(panel)).toHaveLength(0);
    });

    it('CSV table sends an initial snapshot when a watcher reload wins before initial ready completes', async () => {
        const initial = deferred<Uint8Array>();
        const reload = deferred<Uint8Array>();
        const reads = [initial, reload, reload, initial];
        const close_spy = vi.spyOn(CsvDataSource.prototype, 'close');
        let mtime = 0;

        vscode_mock.__setStatImplementation(async () => ({ size: 100, mtime: Math.min(++mtime, 2) }));
        vscode_mock.__setReadFileImplementation(async () => reads.shift()!.promise);

        open_csv_table(uri('/tmp/race.csv'));
        const panel = vscode_mock.__getPanels()[0];
        const initial_ready = panel.__receive({ type: 'ready' });
        const reload_done = vscode_mock.__getWatchers()[0].__fireChange();

        reload.resolve(enc.encode('h\nn\n1\n2\n'));
        await reload_done;
        initial.resolve(enc.encode('h\nold\n'));
        await initial_ready;

        const metas = initial_snapshots(panel);
        expect(metas).toHaveLength(1);
        expect(metas[0].meta.sheets[0].rowCount).toBe(3);
        expect(refresh_snapshots(panel)).toHaveLength(0);
        expect(close_spy).toHaveBeenCalledTimes(1);
    });

    it('CSV table still sends an initial snapshot for a post-ready reload after a pre-ready reload completed', async () => {
        const pre_ready_reload = deferred<Uint8Array>();
        const post_ready_reload = deferred<Uint8Array>();
        const reads = [
            pre_ready_reload,
            pre_ready_reload,
            post_ready_reload,
            post_ready_reload,
        ];

        vscode_mock.__setStatImplementation(async () => ({ size: 100, mtime: 1 }));
        vscode_mock.__setReadFileImplementation(async () => reads.shift()!.promise);

        open_csv_table(uri('/tmp/race.csv'));
        const panel = vscode_mock.__getPanels()[0];
        const watcher = vscode_mock.__getWatchers()[0];
        const pre_ready_done = watcher.__fireChange();

        pre_ready_reload.resolve(enc.encode('h\npre\n'));
        await pre_ready_done;
        panel.__messages.length = 0;

        await panel.__receive({ type: 'ready' });
        await flush_promises();
        const post_ready_done = watcher.__fireChange();

        post_ready_reload.resolve(enc.encode('h\nn\n1\n2\n'));
        await post_ready_done;

        const metas = initial_snapshots(panel);
        expect(metas).toHaveLength(1);
        expect(metas[0].meta.sheets[0].rowCount).toBe(1);
        expect(refresh_snapshots(panel).at(-1)?.meta.sheets[0].rowCount).toBe(3);
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

        expect(initial_snapshots(panel)).toHaveLength(0);
        expect(refresh_snapshots(panel)).toHaveLength(0);
        expect(close_spy).toHaveBeenCalledTimes(1);
    });

    it('CSV preview ignores an older reload and sends an initial snapshot when the newer reload is first delivery', async () => {
        const older = deferred<Uint8Array>();
        const newer = deferred<Uint8Array>();
        // Each candidate is read once to parse and once immediately before
        // adoption. The newer candidate completes verification first.
        const reads = [older, newer, newer, older];
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
        expect(workbook_snapshots(panel)).toHaveLength(0);
        await panel.__receive({ type: 'ready' });
        const metas = initial_snapshots(panel);
        expect(metas).toHaveLength(1);
        expect(metas[0].meta.sheets[0].rowCount).toBe(3);
        expect(metas[0].previewMode).toBe(true);
        expect(refresh_snapshots(panel)).toHaveLength(0);
        expect(close_spy).toHaveBeenCalledTimes(1);
    });

    it('CSV preview sends an initial snapshot with previewMode when a watcher reload wins before initial ready completes', async () => {
        const initial = deferred<Uint8Array>();
        const reload = deferred<Uint8Array>();
        const reads = [initial, reload, reload, initial];
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

        const metas = initial_snapshots(panel);
        expect(metas).toHaveLength(1);
        expect(metas[0].meta.sheets[0].rowCount).toBe(3);
        expect(metas[0].previewMode).toBe(true);
        expect(refresh_snapshots(panel)).toHaveLength(0);
        expect(close_spy).toHaveBeenCalledTimes(1);
    });

    it('CSV preview still sends an initial snapshot for a post-ready reload after a pre-ready reload completed', async () => {
        const pre_ready_reload = deferred<Uint8Array>();
        const post_ready_reload = deferred<Uint8Array>();
        const reads = [
            pre_ready_reload,
            pre_ready_reload,
            post_ready_reload,
            post_ready_reload,
        ];

        vscode_mock.__setStatImplementation(async () => ({ size: 100, mtime: 0 }));
        vscode_mock.__setReadFileImplementation(async () => reads.shift()!.promise);

        show_csv_preview(uri('/tmp/race.csv'), uri('/ext'), state_store(), view_column(vscode_mock.ViewColumn.Active));
        const panel = vscode_mock.__getPanels()[0];
        const watcher = vscode_mock.__getWatchers()[0];
        const pre_ready_done = watcher.__fireChange();

        pre_ready_reload.resolve(enc.encode('h\npre\n'));
        await pre_ready_done;
        panel.__messages.length = 0;

        await panel.__receive({ type: 'ready' });
        await flush_promises();
        const post_ready_done = watcher.__fireChange();

        post_ready_reload.resolve(enc.encode('h\nn\n1\n2\n'));
        await post_ready_done;
        await flush_promises();

        const metas = initial_snapshots(panel);
        expect(metas).toHaveLength(1);
        expect(metas[0].meta.sheets[0].rowCount).toBe(1);
        expect(metas[0].previewMode).toBe(true);
        expect(refresh_snapshots(panel).at(-1)?.meta.sheets[0].rowCount).toBe(3);
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
        const old_ready = panel.__receive({ type: 'ready' });

        show_csv_preview(uri('/tmp/new.csv'), uri('/ext'), state_store(), view_column(vscode_mock.ViewColumn.Active));
        const new_ready = panel.__receive({ type: 'ready' });

        new_load.resolve(enc.encode('h\nn\n1\n2\n'));
        await new_ready;
        old_load.resolve(enc.encode('h\nold\n'));
        await old_ready;

        const metas = initial_snapshots(panel);
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
            if (call <= 2) return enc.encode('h\na\n'); // initial parse + verification
            if (call === 3) return stale.promise; // in-flight watcher parse
            if (call === 4) return enc.encode('h\na\n'); // save conflict check
            // Save reparse and the stale candidate's final verification see the
            // bytes that were written, so the stale candidate must be rejected.
            return enc.encode('h\na\nb\n');
        });

        open_csv_table(uri('/tmp/save.csv'));
        const panel = vscode_mock.__getPanels()[0];
        await panel.__receive({ type: 'ready' });
        await panel.__receive({ type: 'requestEditSession' });

        const watcher = vscode_mock.__getWatchers()[0];
        const reload_done = watcher.__fireChange();      // starts the in-flight reload
        await flush_promises();

        await panel.__receive({ type: 'saveCsv', edits: { '1:0': 'b' } });

        // The older reload resolves only after the save has adopted its result.
        stale.resolve(enc.encode('h\nx\ny\nz\n'));                  // rowCount 3
        await reload_done;

        const reloads = refresh_snapshots(panel);
        // The save's refresh snapshot (rowCount 2) must stand; the stale reload's
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
            if (call <= 3) return enc.encode('h\na\n'); // ready + save conflict check
            if (call <= 5) return enc.encode('h\na\nb\n'); // save parse + verification
            return enc.encode('h\np\nq\nr\ns\nt\n'); // external parse + verification
        });

        open_csv_table(uri('/tmp/save.csv'));
        const panel = vscode_mock.__getPanels()[0];
        await panel.__receive({ type: 'ready' });
        await panel.__receive({ type: 'requestEditSession' });

        await panel.__receive({ type: 'saveCsv', edits: { '1:0': 'b' } });

        // An external edit changes the file (new mtime) right after the save.
        current_mtime = 2;
        await vscode_mock.__getWatchers()[0].__fireChange();

        const reloads = refresh_snapshots(panel);
        expect(reloads.some((r) => r.meta.sheets[0].rowCount === 5)).toBe(true);
    });

    it('retries failed post-save metadata delivery and then deduplicates safely', async () => {
        vi.useFakeTimers();
        const close_spy = vi.spyOn(CsvDataSource.prototype, 'close');
        let reads = 0;
        vscode_mock.__setStatImplementation(async () => ({ size: 100, mtime: 1 }));
        vscode_mock.__setReadFileImplementation(async () => {
            reads += 1;
            return reads <= 3
                ? enc.encode('h\na\n')
                : enc.encode('h\nb\n');
        });
        open_csv_table(uri('/tmp/save-delivery.csv'));
        const panel = vscode_mock.__getPanels()[0];
        await panel.__receive({ type: 'ready' });
        await panel.__receive({ type: 'requestEditSession' });
        const original_post = panel.webview.postMessage.bind(panel.webview);
        let reload_attempts = 0;
        vi.spyOn(panel.webview, 'postMessage').mockImplementation(async (message: unknown) => {
            if (
                typeof message === 'object'
                && message !== null
                && 'type' in message
                && message.type === 'workbookSnapshot'
            ) {
                reload_attempts += 1;
                if (reload_attempts === 1) return false;
            }
            return original_post(message);
        });

        await panel.__receive({ type: 'saveCsv', edits: { '0:0': 'b' } });
        await vi.advanceTimersByTimeAsync(50);

        expect(reload_attempts).toBe(2);
        expect(refresh_snapshots(panel)).toMatchObject([{
            sourceGeneration: 2,
            generation: 2,
        }]);
        await vscode_mock.__getWatchers()[0].__fireChange();
        expect(reload_attempts).toBe(2);
        expect(close_spy).toHaveBeenCalledTimes(2);
        vi.useRealTimers();
    });

    it('keeps an in-flight watcher viable when the post-save reparse cannot build', async () => {
        vi.useFakeTimers();
        const watcher_bytes = deferred<Uint8Array>();
        const first_reparse_failed = deferred<void>();
        let reads = 0;
        vscode_mock.__setStatImplementation(async () => ({ size: 100, mtime: 1 }));
        vscode_mock.__setReadFileImplementation(async () => {
            reads += 1;
            if (reads <= 2) return enc.encode('h\na\n');
            if (reads === 3) return watcher_bytes.promise;
            if (reads === 4) return enc.encode('h\na\n');
            if (reads === 5) {
                first_reparse_failed.resolve();
                throw Object.assign(new Error('busy'), { code: 'EBUSY' });
            }
            if (reads === 6) return enc.encode('h\na\nb\n');
            throw Object.assign(new Error('busy'), { code: 'EBUSY' });
        });
        open_csv_table(uri('/tmp/save-watcher-fallback.csv'));
        const panel = vscode_mock.__getPanels()[0];
        await panel.__receive({ type: 'ready' });
        await panel.__receive({ type: 'requestEditSession' });
        const watcher_done = vscode_mock.__getWatchers()[0].__fireChange();
        await flush_promises();
        const save_done = panel.__receive({ type: 'saveCsv', edits: { '1:0': 'b' } });
        await first_reparse_failed.promise;

        watcher_bytes.resolve(enc.encode('h\na\nb\n'));
        await watcher_done;
        expect(refresh_snapshots(panel)).toMatchObject([{
            meta: { sheets: [{ rowCount: 2 }] },
        }]);

        await vi.advanceTimersByTimeAsync(500);
        await save_done;
        expect(panel.__messages).toContainEqual({ type: 'saveResult', success: true });
        vi.useRealTimers();
    });

    it('reports save success even when the post-write reload fails', async () => {
        // The write succeeded, so the bytes are on disk. If the follow-up
        // re-parse throws (transient read error / external delete in the TOCTOU
        // window), the save must still be reported as successful, not failed.
        let call = 0;
        vscode_mock.__setStatImplementation(async () => ({ size: 100, mtime: 1 }));
        vscode_mock.__setReadFileImplementation(async () => {
            call++;
            if (call <= 3) return enc.encode('h\na\n'); // ready + conflict digest check
            throw new Error('reload boom'); // bounded post-save reparses fail
        });

        open_csv_table(uri('/tmp/save.csv'));
        const panel = vscode_mock.__getPanels()[0];
        await panel.__receive({ type: 'ready' });
        await panel.__receive({ type: 'requestEditSession' });

        await panel.__receive({ type: 'saveCsv', edits: { '0:0': 'b' } });

        const results = panel.__messages.filter(
            (m): m is { type: string; success: boolean } => (
                typeof m === 'object' && m !== null && 'type' in m
                && (m as { type: string }).type === 'saveResult'
            ),
        );
        expect(results).toEqual([{ type: 'saveResult', success: true }]);
    });

    it('refuses a same-size same-mtime external edit before saving', async () => {
        let reads = 0;
        vscode_mock.__setStatImplementation(async () => ({ size: 100, mtime: 1 }));
        vscode_mock.__setReadFileImplementation(async () => {
            reads += 1;
            return reads <= 2
                ? enc.encode('h\na\n')
                : enc.encode('h\nx\n');
        });
        const warning_spy = vi.spyOn(vscode_mock.window, 'showWarningMessage');

        open_csv_table(uri('/tmp/digest-conflict.csv'));
        const panel = vscode_mock.__getPanels()[0];
        await panel.__receive({ type: 'ready' });
        await panel.__receive({ type: 'requestEditSession' });
        await panel.__receive({ type: 'saveCsv', edits: { '0:0': 'b' } });

        expect(panel.__messages).toContainEqual({ type: 'saveResult', success: false });
        expect(warning_spy).toHaveBeenCalledWith(
            expect.stringContaining('modified externally'),
        );
    });

    it('detects an external edit that lands during CSV serialization', async () => {
        let external_changed = false;
        vscode_mock.__setStatImplementation(async () => ({ size: 100, mtime: 1 }));
        vscode_mock.__setReadFileImplementation(async () => external_changed
            ? enc.encode('h\nx\n')
            : enc.encode('h\na\n'));
        const original_read_rows = CsvDataSource.prototype.read_rows;
        vi.spyOn(CsvDataSource.prototype, 'read_rows').mockImplementation(function (
            this: CsvDataSource,
            ...args: Parameters<CsvDataSource['read_rows']>
        ) {
            external_changed = true;
            return original_read_rows.apply(this, args);
        });

        open_csv_table(uri('/tmp/serialization-conflict.csv'));
        const panel = vscode_mock.__getPanels()[0];
        await panel.__receive({ type: 'ready' });
        await panel.__receive({ type: 'requestEditSession' });
        await panel.__receive({ type: 'saveCsv', edits: { '0:0': 'b' } });

        expect(panel.__messages).toContainEqual({ type: 'saveResult', success: false });
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
            if (call <= 2) return enc.encode('h\na\n'); // initial parse + verification
            if (call === 3) return enc.encode('h\nx\n'); // conflict digest check
            throw new Error('reload boom'); // bounded post-conflict reparses fail
        });
        const error_spy = vi.spyOn(vscode_mock.window, 'showErrorMessage');

        open_csv_table(uri('/tmp/save.csv'));
        const panel = vscode_mock.__getPanels()[0];
        await panel.__receive({ type: 'ready' });
        await panel.__receive({ type: 'requestEditSession' });

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
        const old_read_started = deferred<void>();
        const new_load = deferred<Uint8Array>();
        const close_spy = vi.spyOn(CsvDataSource.prototype, 'close');

        vscode_mock.__setStatImplementation(async () => ({ size: 100, mtime: 0 }));
        vscode_mock.__setReadFileImplementation(async (request_uri) => {
            if (request_uri.fsPath === '/tmp/old.csv') {
                old_read_started.resolve();
                return old_reload.promise;
            }
            return new_load.promise;
        });

        show_csv_preview(uri('/tmp/old.csv'), uri('/ext'), state_store(), view_column(vscode_mock.ViewColumn.Active));
        const panel = vscode_mock.__getPanels()[0];
        const old_reload_done = vscode_mock.__getWatchers()[0].__fireChange();
        await old_read_started.promise;
        await old_reload_done;

        show_csv_preview(uri('/tmp/new.csv'), uri('/ext'), state_store(), view_column(vscode_mock.ViewColumn.Active));
        void panel.__receive({ type: 'ready' });

        new_load.resolve(enc.encode('h\nn\n1\n2\n'));
        await flush_promises();
        old_reload.resolve(enc.encode('h\nold\n'));
        await old_reload_done;
        await flush_promises();
        expect(vscode_mock.__getWatcherHistory()).toHaveLength(2);
        expect(vscode_mock.__getWatcherHistory()[0].__disposed).toBe(true);
        expect(vscode_mock.__getActiveWatchers()).toHaveLength(1);

        const metas = initial_snapshots(panel);
        expect(metas).toHaveLength(1);
        expect(metas[0].meta.sheets[0].rowCount).toBe(3);
        expect(refresh_snapshots(panel)).toHaveLength(0);
        expect(close_spy).toHaveBeenCalledTimes(1);
    });
});
