import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as vscode from 'vscode';
import type { ExtensionContext } from 'vscode';
import { attach_viewer, csv_table_profile, type ViewerProfile } from '../viewer-controller';
import {
    create_file_state_store,
    type FileStateSnapshot,
    type FileStateStore,
} from '../state';
import type { PerFileState } from '../types';
import type { DataSource, RowWindow, WorkbookMeta } from '../data-source/interface';
import { versioned_state_store } from './helpers/versioned-state-store';
import * as vscode_mock from './mocks/vscode';
import { file_coordinator_registry_size } from '../file-coordinator';
import { with_in_memory_authority_transactions } from '../state-authority';
import type { WorkbookSnapshot, WorkbookSnapshotIdentity } from '../viewer-snapshot';

const enc = new TextEncoder();

function deferred<T = void>() {
    let resolve!: (value: T | PromiseLike<T>) => void;
    const promise = new Promise<T>((done) => { resolve = done; });
    return { promise, resolve };
}

async function flush_promises(): Promise<void> {
    for (let index = 0; index < 100; index += 1) await Promise.resolve();
}

function state_store(initial: PerFileState = {}) {
    return versioned_state_store(initial);
}

function uri(path: string): vscode.Uri {
    return vscode_mock.Uri.file(path) as unknown as vscode.Uri;
}

class StubSource implements DataSource {
    constructor(public readonly truncationMessage?: string) {}
    meta(): WorkbookMeta {
        return {
            hasFormatting: false,
            sheets: [{
                name: 'Sheet1',
                rowCount: 1,
                columnCount: 1,
                merges: [],
                hasFormatting: false,
            }],
        };
    }
    read_rows(): RowWindow {
        return { startRow: 0, rows: [[{ raw: 'a', formatted: 'a', bold: false, italic: false }]] };
    }
    close(): void {}
}

class FailingTransformSource extends StubSource {
    override read_rows(): RowWindow {
        throw new Error('column read failed');
    }
}

class SignallingInvalidFilterSource extends StubSource {
    constructor(private readonly on_read: () => void) {
        super();
    }
    override read_rows(): RowWindow {
        this.on_read();
        return {
            startRow: 0,
            rows: [[{
                raw: '1',
                rawType: 'number',
                formatted: '1',
                bold: false,
                italic: false,
            }]],
        };
    }
}

class TwoSheetSource extends StubSource {
    override meta(): WorkbookMeta {
        return {
            hasFormatting: false,
            sheets: [
                {
                    name: 'Sheet1',
                    rowCount: 1,
                    columnCount: 2,
                    merges: [],
                    hasFormatting: false,
                },
                {
                    name: 'Sheet2',
                    rowCount: 1,
                    columnCount: 2,
                    merges: [],
                    hasFormatting: false,
                },
            ],
        };
    }
}

function two_sheet_profile(): ViewerProfile {
    return {
        editing: false,
        build_source: async () => new TwoSheetSource(),
    };
}

function open_csv_table(
    file_uri: vscode.Uri,
    store: FileStateStore,
    profile: ViewerProfile = csv_table_profile(),
) {
    const panel = vscode_mock.window.createWebviewPanel('tableViewer.editor', 'table');
    const controller = attach_viewer(
        panel as unknown as Parameters<typeof attach_viewer>[0],
        file_uri,
        with_in_memory_authority_transactions(store),
        profile,
    );
    panel.onDidDispose(() => controller.dispose());
    return panel;
}

function uncertain_cleanup_store(initial: PerFileState) {
    const versioned = state_store(initial);
    const recovery_started = deferred();
    const recovery_gate = deferred();
    let cleanup_attempts = 0;
    const store: FileStateStore = {
        ...versioned.store,
        async compare_and_set(path, expected, next, validate) {
            const current = await versioned.store.read(path);
            if ((current.state as PerFileState).pendingEdits && !next.pendingEdits) {
                cleanup_attempts += 1;
                if (cleanup_attempts === 1) throw new Error('initial cleanup failed');
                recovery_started.resolve();
                await recovery_gate.promise;
            }
            return versioned.store.compare_and_set(path, expected, next, validate);
        },
    };
    return { versioned, store, recovery_started, recovery_gate };
}

function edit_session_results(panel: { __messages: unknown[] }) {
    return panel.__messages.filter(
        (message): message is {
            type: string;
            requestId?: string;
            granted: boolean;
            editSessionId?: string;
            pendingEdits?: PerFileState['pendingEdits'];
        } => (
            typeof message === 'object'
            && message !== null
            && 'type' in message
            && message.type === 'editSessionResult'
        )
    ).map(({ editSessionId: _session, requestId: _request, ...message }) => message);
}

function latest_edit_session_message(panel: { __messages: unknown[] }) {
    return [...panel.__messages].reverse().find((message): message is {
        type: 'editSessionResult';
        granted: boolean;
        editSessionId?: string;
        pendingEdits?: PerFileState['pendingEdits'];
    } => (
        typeof message === 'object'
        && message !== null
        && 'type' in message
        && message.type === 'editSessionResult'
    ));
}

function latest_snapshot(panel: { __messages: unknown[] }): WorkbookSnapshot {
    const message = [...panel.__messages].reverse().find((candidate) => (
        typeof candidate === 'object'
        && candidate !== null
        && 'type' in candidate
        && candidate.type === 'workbookSnapshot'
        && 'snapshot' in candidate
    )) as { snapshot: WorkbookSnapshot };
    return message.snapshot;
}

function initial_snapshot(panel: { __messages: unknown[] }): {
    generation: number;
    sourceGeneration: number;
    state: PerFileState;
    identity: WorkbookSnapshotIdentity;
} {
    const message = panel.__messages.find((candidate) => (
        typeof candidate === 'object'
        && candidate !== null
        && 'type' in candidate
        && candidate.type === 'workbookSnapshot'
        && 'snapshot' in candidate
        && (candidate.snapshot as { presentation?: string }).presentation === 'initial'
    )) as { snapshot: {
        generation: number;
        sourceGeneration: number;
        state: PerFileState;
        identity: WorkbookSnapshotIdentity;
    } };
    return message.snapshot;
}

function sheet_meta_count(panel: { __messages: unknown[] }) {
    return panel.__messages.filter(
        (message) => (
            typeof message === 'object'
            && message !== null
            && 'type' in message
            && message.type === 'workbookSnapshot'
            && 'snapshot' in message
            && (message.snapshot as { presentation?: string }).presentation === 'initial'
        )
    ).length;
}

beforeEach(() => {
    for (const panel of vscode_mock.__getPanels()) panel.dispose();
    vi.restoreAllMocks();
    vscode_mock.__reset();
    vscode_mock.__setStatImplementation(async () => ({ size: 100, mtime: 1 }));
    vscode_mock.__setReadFileImplementation(async () => enc.encode('h\na\n'));
});

describe('CSV edit sessions', () => {
    it('invalidates old receiver retries before awaiting ready-state refresh', async () => {
        vi.useFakeTimers();
        const versioned = state_store();
        const gate = deferred();
        let gate_reads = false;
        const store: FileStateStore = {
            ...versioned.store,
            async read(path) {
                if (gate_reads) await gate.promise;
                return versioned.store.read(path);
            },
        };
        const panel = open_csv_table(uri('/tmp/ready-read-gate.csv'), store);
        const original_post = panel.webview.postMessage.bind(panel.webview);
        let snapshot_attempts = 0;
        vi.spyOn(panel.webview, 'postMessage').mockImplementation(async (message: unknown) => {
            if (
                typeof message === 'object'
                && message !== null
                && 'type' in message
                && message.type === 'workbookSnapshot'
            ) {
                snapshot_attempts += 1;
                if (snapshot_attempts === 1) return false;
            }
            return original_post(message);
        });
        await panel.__receive({ type: 'ready' });
        expect(snapshot_attempts).toBe(1);

        gate_reads = true;
        const repeated_ready = panel.__receive({ type: 'ready' });
        await Promise.resolve();
        await vi.advanceTimersByTimeAsync(500);
        expect(snapshot_attempts).toBe(1);

        gate.resolve();
        await repeated_ready;
        expect(snapshot_attempts).toBe(2);
        vi.useRealTimers();
    });

    it('retries a failed ready-state read and completes once with fresh state', async () => {
        vi.useFakeTimers();
        const versioned = state_store();
        let fail_next = false;
        const store: FileStateStore = {
            ...versioned.store,
            async read(path) {
                if (fail_next) {
                    fail_next = false;
                    throw new Error('transient state read');
                }
                if (versioned.revision(path) === 0) return versioned.store.read(path);
                return { revision: 5, state: { columnWidths: [{ 0: 188 }] } };
            },
        };
        const panel = open_csv_table(uri('/tmp/ready-read-retry.csv'), store);
        await panel.__receive({ type: 'ready' });
        const before = sheet_meta_count(panel);
        // Make the successful retry return an explicit newer snapshot.
        await versioned.store.compare_and_set('/tmp/ready-read-retry.csv', 0, {});
        fail_next = true;
        const ready = panel.__receive({ type: 'ready' });
        await Promise.resolve();
        await vi.advanceTimersByTimeAsync(50);
        await ready;

        expect(sheet_meta_count(panel)).toBe(before + 1);
        expect(latest_snapshot(panel).identity.stateRevision).toBe(5);
        expect(latest_snapshot(panel).state.columnWidths).toEqual([{ 0: 188 }]);
        vi.useRealTimers();
    });

    it('completes with retained state after bounded ready-state read failures', async () => {
        vi.useFakeTimers();
        const versioned = state_store();
        let fail_reads = false;
        const store: FileStateStore = {
            ...versioned.store,
            async read(path) {
                if (fail_reads) throw new Error('persistent state read');
                return versioned.store.read(path);
            },
        };
        const panel = open_csv_table(uri('/tmp/ready-read-fallback.csv'), store);
        await panel.__receive({ type: 'ready' });
        const retained = latest_snapshot(panel);
        const before = sheet_meta_count(panel);
        fail_reads = true;
        const error_spy = vi.spyOn(console, 'error').mockImplementation(() => {});
        const ready = panel.__receive({ type: 'ready' });
        await vi.advanceTimersByTimeAsync(1_000);
        await ready;

        expect(sheet_meta_count(panel)).toBe(before + 1);
        const fallback = latest_snapshot(panel);
        expect(fallback.identity.stateRevision).toBe(retained.identity.stateRevision);
        expect(fallback.state).toEqual(retained.state);
        expect(fallback.identity.deliveryId).toBeGreaterThan(retained.identity.deliveryId);
        expect(error_spy).toHaveBeenCalledOnce();
        vi.useRealTimers();
    });

    it('makes an older ready retry inert when a newer ready succeeds', async () => {
        vi.useFakeTimers();
        const versioned = state_store();
        let ready_reads = 0;
        let ready_mode = false;
        const store: FileStateStore = {
            ...versioned.store,
            async read(path) {
                if (!ready_mode) return versioned.store.read(path);
                ready_reads += 1;
                if (ready_reads === 1) throw new Error('older read failed');
                return { revision: 6, state: { rowHeights: [{ 0: 29 }] } };
            },
        };
        const panel = open_csv_table(uri('/tmp/ready-newer-wins.csv'), store);
        await panel.__receive({ type: 'ready' });
        const before = sheet_meta_count(panel);
        ready_mode = true;
        const older = panel.__receive({ type: 'ready' });
        await Promise.resolve();
        const newer = panel.__receive({ type: 'ready' });
        await newer;
        await vi.advanceTimersByTimeAsync(500);
        await older;

        expect(sheet_meta_count(panel)).toBe(before + 1);
        expect(latest_snapshot(panel).identity.stateRevision).toBe(6);
        expect(latest_snapshot(panel).state.rowHeights).toEqual([{ 0: 29 }]);
        vi.useRealTimers();
    });

    it('cancels ready-state retry waits on disposal without posting', async () => {
        vi.useFakeTimers();
        const versioned = state_store();
        let fail_reads = false;
        const store: FileStateStore = {
            ...versioned.store,
            async read(path) {
                if (fail_reads) throw new Error('state unavailable');
                return versioned.store.read(path);
            },
        };
        const panel = open_csv_table(uri('/tmp/ready-dispose-retry.csv'), store);
        await panel.__receive({ type: 'ready' });
        const before = sheet_meta_count(panel);
        fail_reads = true;
        const ready = panel.__receive({ type: 'ready' });
        await Promise.resolve();
        panel.dispose();
        await ready;

        expect(sheet_meta_count(panel)).toBe(before);
        expect(vi.getTimerCount()).toBe(0);
        vi.useRealTimers();
    });

    it('ignores an older ready completion when durable reads finish out of order', async () => {
        const versioned = state_store();
        const queued: Array<ReturnType<typeof deferred<FileStateSnapshot>>> = [];
        const store: FileStateStore = {
            ...versioned.store,
            async read(path) {
                const next = queued.shift();
                return next ? next.promise : versioned.store.read(path);
            },
        };
        const panel = open_csv_table(uri('/tmp/ready-order.csv'), store);
        await panel.__receive({ type: 'ready' });
        const before = panel.__messages.filter((message) => (
            typeof message === 'object'
            && message !== null
            && 'type' in message
            && message.type === 'workbookSnapshot'
        )).length;
        const older = deferred<FileStateSnapshot>();
        const newer = deferred<FileStateSnapshot>();
        const newer_confirmation = deferred<FileStateSnapshot>();
        queued.push(older, newer, newer_confirmation);

        const older_ready = panel.__receive({ type: 'ready' });
        const newer_ready = panel.__receive({ type: 'ready' });
        const newer_state = { revision: 3, state: { columnWidths: [{ 0: 203 }] } };
        newer.resolve(newer_state);
        await Promise.resolve();
        newer_confirmation.resolve(newer_state);
        await newer_ready;
        older.resolve({ revision: 3, state: { columnWidths: [{ 0: 102 }] } });
        await older_ready;

        const snapshots = panel.__messages.filter((message) => (
            typeof message === 'object'
            && message !== null
            && 'type' in message
            && message.type === 'workbookSnapshot'
        ));
        expect(snapshots).toHaveLength(before + 1);
        expect(latest_snapshot(panel).identity.stateRevision).toBe(3);
        expect(latest_snapshot(panel).state.columnWidths).toEqual([{ 0: 203 }]);
    });

    it('replays exact committed layout state on ready without an echo delivery', async () => {
        const file_path = '/tmp/repeated-ready-layout.csv';
        const state = state_store();
        const panel = open_csv_table(uri(file_path), state.store);
        await panel.__receive({ type: 'ready' });
        const first = latest_snapshot(panel);
        const before = panel.__messages.filter((message) => (
            typeof message === 'object'
            && message !== null
            && 'type' in message
            && message.type === 'workbookSnapshot'
        )).length;

        await panel.__receive({
            type: 'stateChanged',
            sourceGeneration: first.sourceGeneration,
            snapshotIdentity: first.identity,
            state: {
                ...first.state,
                columnWidths: [{ 0: 177 }],
                activeSheetIndex: 0,
            },
        });
        expect(panel.__messages.filter((message) => (
            typeof message === 'object'
            && message !== null
            && 'type' in message
            && message.type === 'workbookSnapshot'
        ))).toHaveLength(before);

        await panel.__receive({ type: 'ready' });
        const replay = latest_snapshot(panel);
        expect(replay.identity.stateRevision).toBeGreaterThan(first.identity.stateRevision);
        expect(replay.state.columnWidths).toEqual([{ 0: 177 }]);
        expect(replay.generation).toBe(first.generation);
        expect(replay.sourceGeneration).toBe(first.sourceGeneration);
        expect(replay.identity.sourceBasis).toEqual(first.identity.sourceBasis);
    });

    it('uses the exact committed state snapshot after a CAS conflict', async () => {
        const file_path = '/tmp/state-conflict-replay.csv';
        const versioned = state_store();
        let inject_conflict = true;
        const store: FileStateStore = {
            ...versioned.store,
            async compare_and_set(path, expected, next, validate) {
                if (inject_conflict) {
                    inject_conflict = false;
                    const external = await versioned.store.compare_and_set(
                        path,
                        expected,
                        { rowHeights: [{ 0: 41 }] },
                    );
                    if (external.type !== 'committed') throw new Error('Expected injected commit.');
                    return { type: 'conflict', snapshot: external.snapshot };
                }
                return versioned.store.compare_and_set(path, expected, next, validate);
            },
        };
        const panel = open_csv_table(uri(file_path), store);
        await panel.__receive({ type: 'ready' });
        const first = latest_snapshot(panel);
        const before = panel.__messages.length;
        await panel.__receive({
            type: 'stateChanged',
            sourceGeneration: first.sourceGeneration,
            snapshotIdentity: first.identity,
            state: { ...first.state, columnWidths: [{ 0: 166 }] },
        });
        expect(panel.__messages).toHaveLength(before);

        await panel.__receive({ type: 'ready' });
        const replay = latest_snapshot(panel);
        expect(replay.identity.stateRevision).toBe(2);
        expect(replay.state.columnWidths).toEqual([{ 0: 166 }]);
        expect(replay.state.rowHeights).toEqual([{ 0: 41 }]);
    });

    it('derives initial intent from the exact ACK and preserves unseen peer layout', async () => {
        const file_path = '/tmp/exact-acked-layout-basis.csv';
        const versioned = state_store({
            columnWidths: [{ 0: 100 }],
            rowHeights: [{ 0: 20 }],
        });
        const panel = open_csv_table(uri(file_path), versioned.store);
        await panel.__receive({ type: 'ready' });
        const acknowledged = latest_snapshot(panel);

        const peer = await versioned.store.compare_and_set(
            file_path,
            versioned.revision(file_path),
            {
                columnWidths: [{ 0: 100 }],
                rowHeights: [{ 0: 30 }],
            },
        );
        expect(peer.type).toBe('committed');
        await panel.__receive({
            type: 'setColumnVisibility',
            sheetIndex: 0,
            sheetName: 'Sheet1',
            sourceGeneration: acknowledged.sourceGeneration,
            state: undefined,
        } as never);
        await flush_promises();
        const visibility_snapshot = latest_snapshot(panel);

        await panel.__receive({
            type: 'stateChanged',
            sourceGeneration: visibility_snapshot.sourceGeneration,
            snapshotIdentity: visibility_snapshot.identity,
            state: {
                ...visibility_snapshot.state,
                columnWidths: [{ 0: 120 }],
            },
        });

        expect(versioned.get_state(file_path).columnWidths).toEqual([{ 0: 120 }]);
        expect(versioned.get_state(file_path).rowHeights).toEqual([{ 0: 30 }]);
    });

    it('skips empty and already-satisfied CAS while advancing the rolling basis', async () => {
        const file_path = '/tmp/layout-semantic-noop.csv';
        const versioned = state_store({ columnWidths: [{ 0: 100 }] });
        let compare_attempts = 0;
        const store: FileStateStore = {
            ...versioned.store,
            async compare_and_set(path, expected, next, validate) {
                compare_attempts += 1;
                return versioned.store.compare_and_set(path, expected, next, validate);
            },
        };
        const panel = open_csv_table(uri(file_path), store);
        await panel.__receive({ type: 'ready' });
        const acknowledged = latest_snapshot(panel);

        await panel.__receive({
            type: 'stateChanged',
            sourceGeneration: acknowledged.sourceGeneration,
            snapshotIdentity: acknowledged.identity,
            state: acknowledged.state,
        });
        expect(compare_attempts).toBe(0);

        const peer = await versioned.store.compare_and_set(
            file_path,
            versioned.revision(file_path),
            { columnWidths: [{ 0: 120 }] },
        );
        expect(peer.type).toBe('committed');
        await panel.__receive({
            type: 'stateChanged',
            sourceGeneration: acknowledged.sourceGeneration,
            snapshotIdentity: acknowledged.identity,
            state: { ...acknowledged.state, columnWidths: [{ 0: 120 }] },
        });
        expect(compare_attempts).toBe(0);
        expect(versioned.get_state(file_path).columnWidths).toEqual([{ 0: 120 }]);

        await panel.__receive({
            type: 'stateChanged',
            sourceGeneration: acknowledged.sourceGeneration,
            snapshotIdentity: acknowledged.identity,
            state: { ...acknowledged.state, columnWidths: [{ 0: 100 }] },
        });
        expect(compare_attempts).toBe(1);
        expect(versioned.get_state(file_path).columnWidths).toEqual([{ 0: 100 }]);
    });

    it('merges disjoint layout changes from two tabs that read the same revision', async () => {
        const file_path = '/tmp/disjoint-layout-tabs.csv';
        const versioned = state_store();
        const reads_ready = deferred();
        let coordinate_reads = false;
        let coordinated_reads = 0;
        const store: FileStateStore = {
            ...versioned.store,
            async read(path) {
                const snapshot = await versioned.store.read(path);
                if (!coordinate_reads) return snapshot;
                coordinated_reads += 1;
                if (coordinated_reads === 2) reads_ready.resolve();
                await reads_ready.promise;
                return snapshot;
            },
        };
        const first = open_csv_table(uri(file_path), store, two_sheet_profile());
        const second = open_csv_table(uri(file_path), store, two_sheet_profile());
        await first.__receive({ type: 'ready' });
        await second.__receive({ type: 'ready' });
        const first_snapshot = latest_snapshot(first);
        const second_snapshot = latest_snapshot(second);
        coordinate_reads = true;

        await Promise.all([
            first.__receive({
                type: 'stateChanged',
                sourceGeneration: first_snapshot.sourceGeneration,
                snapshotIdentity: first_snapshot.identity,
                state: {
                    ...first_snapshot.state,
                    columnWidths: [{ 0: 144 }],
                },
            }),
            second.__receive({
                type: 'stateChanged',
                sourceGeneration: second_snapshot.sourceGeneration,
                snapshotIdentity: second_snapshot.identity,
                state: {
                    ...second_snapshot.state,
                    rowHeights: [undefined, { 0: 41 }],
                },
            }),
        ]);

        expect(versioned.get_state(file_path).columnWidths).toEqual([{ 0: 144 }]);
        expect(versioned.get_state(file_path).rowHeights).toEqual([
            undefined,
            { 0: 41 },
        ]);
    });

    it('retries one fixed layout patch after a CAS conflict without losing peer state', async () => {
        const file_path = '/tmp/layout-patch-conflict.csv';
        const versioned = state_store({
            columnWidths: [{ 0: 100 }],
            excelFirstRowHeaders: { Sheet1: 'on' },
        });
        let inject_conflict = true;
        const store: FileStateStore = {
            ...versioned.store,
            async compare_and_set(path, expected, next, validate) {
                if (inject_conflict) {
                    inject_conflict = false;
                    const external = await versioned.store.compare_and_set(
                        path,
                        expected,
                        {
                            columnWidths: [{ 0: 100, 1: 155 }],
                            rowHeights: [{ 0: 37 }],
                            excelFirstRowHeaders: { Sheet1: 'off' },
                        },
                    );
                    if (external.type !== 'committed') throw new Error('Expected conflict.');
                    return { type: 'conflict', snapshot: external.snapshot };
                }
                return versioned.store.compare_and_set(path, expected, next, validate);
            },
        };
        const panel = open_csv_table(uri(file_path), store);
        await panel.__receive({ type: 'ready' });
        const initial = latest_snapshot(panel);

        await panel.__receive({
            type: 'stateChanged',
            sourceGeneration: initial.sourceGeneration,
            snapshotIdentity: initial.identity,
            state: {
                ...initial.state,
                columnWidths: [{ 0: 120 }],
            },
        });

        expect(versioned.get_state(file_path).columnWidths).toEqual([{
            0: 120,
            1: 155,
        }]);
        expect(versioned.get_state(file_path).rowHeights).toEqual([{ 0: 37 }]);
        expect(versioned.get_state(file_path).excelFirstRowHeaders).toEqual({
            Sheet1: 'off',
        });
    });

    it('preserves concurrent per-sheet keys when the panel deletes its known values', async () => {
        const file_path = '/tmp/layout-map-deletions.csv';
        const versioned = state_store({
            columnWidths: [{ 0: 100 }, { 0: 200 }],
            rowHeights: [{ 0: 20 }],
        });
        const panel = open_csv_table(uri(file_path), versioned.store, two_sheet_profile());
        await panel.__receive({ type: 'ready' });
        const initial = latest_snapshot(panel);
        const external = await versioned.store.compare_and_set(
            file_path,
            versioned.revision(file_path),
            {
                columnWidths: [{ 0: 100, 1: 150 }, { 0: 200 }],
                rowHeights: [{ 0: 20, 1: 31 }],
            },
        );
        expect(external.type).toBe('committed');

        await panel.__receive({
            type: 'stateChanged',
            sourceGeneration: initial.sourceGeneration,
            snapshotIdentity: initial.identity,
            state: {
                ...initial.state,
                columnWidths: [undefined, { 0: 220 }],
                rowHeights: [],
            },
        });

        expect(versioned.get_state(file_path).columnWidths).toEqual([
            { 1: 150 },
            { 0: 220 },
        ]);
        expect(versioned.get_state(file_path).rowHeights).toEqual([{ 1: 31 }]);
    });

    it('serializes rapid same-panel layout writes in message order', async () => {
        const file_path = '/tmp/ordered-layout-writes.csv';
        const versioned = state_store();
        const first_started = deferred();
        const release_first = deferred();
        let attempts = 0;
        const store: FileStateStore = {
            ...versioned.store,
            async compare_and_set(path, expected, next, validate) {
                attempts += 1;
                if (attempts === 1) {
                    first_started.resolve();
                    await release_first.promise;
                }
                return versioned.store.compare_and_set(path, expected, next, validate);
            },
        };
        const panel = open_csv_table(uri(file_path), store);
        await panel.__receive({ type: 'ready' });
        const initial = latest_snapshot(panel);
        const first = panel.__receive({
            type: 'stateChanged',
            sourceGeneration: initial.sourceGeneration,
            snapshotIdentity: initial.identity,
            state: { ...initial.state, columnWidths: [{ 0: 140 }] },
        });
        await first_started.promise;
        const second = panel.__receive({
            type: 'stateChanged',
            sourceGeneration: initial.sourceGeneration,
            snapshotIdentity: initial.identity,
            state: { ...initial.state, columnWidths: [{ 0: 180 }] },
        });
        await flush_promises();
        expect(attempts).toBe(1);

        release_first.resolve();
        await Promise.all([first, second]);
        expect(attempts).toBe(2);
        expect(versioned.get_state(file_path).columnWidths).toEqual([{ 0: 180 }]);
    });

    it('rejects stale layout sources and aborts an in-flight write after disposal', async () => {
        const file_path = '/tmp/fenced-layout-write.csv';
        const versioned = state_store();
        const compare_started = deferred();
        const compare_gate = deferred();
        let block_compare = false;
        let compare_attempts = 0;
        const store: FileStateStore = {
            ...versioned.store,
            async compare_and_set(path, expected, next, validate) {
                compare_attempts += 1;
                if (block_compare) {
                    compare_started.resolve();
                    await compare_gate.promise;
                }
                return versioned.store.compare_and_set(path, expected, next, validate);
            },
        };
        const panel = open_csv_table(uri(file_path), store);
        await panel.__receive({ type: 'ready' });
        const initial = latest_snapshot(panel);

        await panel.__receive({
            type: 'stateChanged',
            sourceGeneration: initial.sourceGeneration + 1,
            snapshotIdentity: initial.identity,
            state: { ...initial.state, columnWidths: [{ 0: 120 }] },
        });
        await panel.__receive({
            type: 'stateChanged',
            sourceGeneration: initial.sourceGeneration,
            snapshotIdentity: {
                ...initial.identity,
                authority: {
                    ...initial.identity.authority,
                    revision: initial.identity.authority.revision + 1,
                },
            },
            state: { ...initial.state, columnWidths: [{ 0: 130 }] },
        });
        expect(compare_attempts).toBe(0);

        block_compare = true;
        const pending = panel.__receive({
            type: 'stateChanged',
            sourceGeneration: initial.sourceGeneration,
            snapshotIdentity: initial.identity,
            state: { ...initial.state, columnWidths: [{ 0: 140 }] },
        });
        await compare_started.promise;
        panel.dispose();
        compare_gate.resolve();
        await pending;

        expect(versioned.get_state(file_path).columnWidths).toBeUndefined();
    });

    it('cannot restore pending edits after save clearing and a new ready epoch', async () => {
        const file_path = '/tmp/save-clear-ready.csv';
        const state = state_store();
        const panel = open_csv_table(uri(file_path), state.store);
        await panel.__receive({ type: 'ready' });
        await panel.__receive({ type: 'requestEditSession' });
        await panel.__receive({
            type: 'pendingEditsChanged',
            edits: { '0:0': { value: 'saved', base: 'a' } },
        });
        await panel.__receive({ type: 'saveCsv', edits: { '0:0': 'saved' } });
        expect(state.get_state(file_path).pendingEdits).toBeUndefined();

        await panel.__receive({ type: 'ready' });
        expect(latest_snapshot(panel).state.pendingEdits).toBeUndefined();
    });

    it.each(['read', 'touch'] as const)(
        'denies the exact edit request when state %s rejects after claim reservation',
        async (failure) => {
            const file_path = `/tmp/edit-request-${failure}-rejection.csv`;
            const versioned = state_store();
            let reject_state_io = false;
            const store: FileStateStore = {
                ...versioned.store,
                async read(path) {
                    if (reject_state_io && failure === 'read') {
                        throw new Error('edit state read rejected');
                    }
                    return versioned.store.read(path);
                },
                async touch(path) {
                    if (reject_state_io && failure === 'touch') {
                        throw new Error('edit state touch rejected');
                    }
                    return versioned.store.touch(path);
                },
            };
            const panel = open_csv_table(uri(file_path), store);
            const sibling = open_csv_table(uri(file_path), store);
            await panel.__receive({ type: 'ready' });
            await sibling.__receive({ type: 'ready' });
            reject_state_io = true;
            const error = vi.spyOn(console, 'error').mockImplementation(() => {});

            await expect(panel.__receive({
                type: 'requestEditSession',
                requestId: `request-${failure}`,
            })).resolves.toBeUndefined();
            const result = [...panel.__messages].reverse().find((message) => (
                typeof message === 'object'
                && message !== null
                && 'type' in message
                && message.type === 'editSessionResult'
            ));
            expect(result).toEqual({
                type: 'editSessionResult',
                requestId: `request-${failure}`,
                granted: false,
            });
            expect(error).toHaveBeenCalledWith(
                'Failed to read CSV edit-session state',
                expect.any(Error),
            );

            reject_state_io = false;
            await sibling.__receive({
                type: 'requestEditSession',
                requestId: `sibling-${failure}`,
            });
            expect(edit_session_results(sibling).at(-1)?.granted).toBe(true);
        },
    );

    it('projects a clean owned session across receiver reload and preserves exclusion', async () => {
        const file_path = '/tmp/clean-session-receiver-reload.csv';
        const shared = state_store();
        const owner = open_csv_table(uri(file_path), shared.store);
        const sibling = open_csv_table(uri(file_path), shared.store);
        await owner.__receive({ type: 'ready' });
        await sibling.__receive({ type: 'ready' });
        await owner.__receive({ type: 'requestEditSession', requestId: 'owner' });
        const session_id = latest_edit_session_message(owner)!.editSessionId!;

        owner.__messages.length = 0;
        await owner.__receive({ type: 'ready' });
        const restored = latest_snapshot(owner);
        expect(restored.capabilities).toMatchObject({
            csvEditable: true,
            csvEditSessionId: session_id,
        });
        expect(restored.state.pendingEdits).toBeUndefined();

        await sibling.__receive({ type: 'requestEditSession', requestId: 'blocked' });
        expect(edit_session_results(sibling).at(-1)?.granted).toBe(false);

        await owner.__receive({
            type: 'releaseEditSession',
            editSessionId: session_id,
        });
        await sibling.__receive({ type: 'requestEditSession', requestId: 'recovered' });
        expect(edit_session_results(sibling).at(-1)?.granted).toBe(true);
    });

    it('reacquires with a new edit epoch and rejects delayed messages from the old session', async () => {
        const file_path = '/tmp/reacquired-edit-epoch.csv';
        const state = state_store();
        let bytes = enc.encode('h\na\n');
        vscode_mock.__setStatImplementation(async () => ({ size: bytes.byteLength, mtime: 1 }));
        vscode_mock.__setReadFileImplementation(async () => bytes);
        vscode_mock.__setWriteFileImplementation(async (_uri, content) => {
            bytes = new Uint8Array(content);
        });
        const panel = open_csv_table(uri(file_path), state.store);
        await panel.__receive({ type: 'ready' });
        await panel.__receive({ type: 'requestEditSession' });
        const first = latest_edit_session_message(panel)!;
        expect(first.editSessionId).toBeDefined();
        await panel.__receive({
            type: 'pendingEditsChanged',
            editSessionId: first.editSessionId,
            edits: { '0:0': { value: 'first', base: 'a' } },
        });
        await panel.__receive({
            type: 'saveCsv',
            editSessionId: first.editSessionId,
            edits: { '0:0': 'first' },
        });
        await flush_promises();

        await panel.__receive({ type: 'requestEditSession' });
        const second = latest_edit_session_message(panel)!;
        expect(second.granted).toBe(true);
        expect(second.editSessionId).toBeDefined();
        expect(second.editSessionId).not.toBe(first.editSessionId);

        await panel.__receive({
            type: 'pendingEditsChanged',
            editSessionId: first.editSessionId,
            edits: { '0:0': { value: 'stale', base: 'first' } },
        });
        await panel.__receive({
            type: 'pendingEditsChanged',
            editSessionId: undefined,
            edits: { '0:0': { value: 'idless stale', base: 'first' } },
        });
        expect(state.get_state(file_path).pendingEdits).toBeUndefined();
        await panel.__receive({
            type: 'saveCsv',
            editSessionId: undefined,
            edits: { '0:0': 'idless stale' },
        });
        expect(panel.__messages.filter((message: any) => (
            message?.type === 'saveResult' && message.success === true
        ))).toHaveLength(1);
        await panel.__receive({
            type: 'pendingEditsChanged',
            editSessionId: second.editSessionId,
            edits: { '0:0': { value: 'second', base: 'first' } },
        });
        expect(state.get_state(file_path).pendingEdits).toEqual({
            '0:0': { value: 'second', base: 'first' },
        });
        await panel.__receive({
            type: 'saveCsv',
            editSessionId: second.editSessionId,
            edits: { '0:0': 'second' },
        });
        expect(panel.__messages.filter((message: any) => (
            message?.type === 'saveResult' && message.success === true
        ))).toHaveLength(2);
    });

    it('drains an admitted dirty update before release transfers ownership', async () => {
        const file_path = '/tmp/pending-release-drain.csv';
        const versioned = state_store();
        const compare_started = deferred();
        const compare_gate = deferred();
        const store: FileStateStore = {
            ...versioned.store,
            async compare_and_set(path, expected, next, validate) {
                if (next.pendingEdits?.['0:0']) {
                    compare_started.resolve();
                    await compare_gate.promise;
                }
                return versioned.store.compare_and_set(path, expected, next, validate);
            },
        };
        const owner = open_csv_table(uri(file_path), store);
        const sibling = open_csv_table(uri(file_path), store);
        await owner.__receive({ type: 'ready' });
        await sibling.__receive({ type: 'ready' });
        await owner.__receive({ type: 'requestEditSession', requestId: 'owner' });
        const session_id = latest_edit_session_message(owner)!.editSessionId!;

        const pending = owner.__receive({
            type: 'pendingEditsChanged',
            editSessionId: session_id,
            edits: { '0:0': { value: 'latest', base: 'a' } },
        });
        await compare_started.promise;
        const release = owner.__receive({
            type: 'releaseEditSession',
            editSessionId: session_id,
        });
        await sibling.__receive({ type: 'requestEditSession', requestId: 'blocked' });
        expect(edit_session_results(sibling).at(-1)?.granted).toBe(false);

        compare_gate.resolve();
        await Promise.all([pending, release]);
        expect(versioned.get_state(file_path).pendingEdits).toEqual({
            '0:0': { value: 'latest', base: 'a' },
        });
        await sibling.__receive({ type: 'requestEditSession', requestId: 'after-drain' });
        expect(edit_session_results(sibling).at(-1)).toMatchObject({
            granted: true,
            pendingEdits: { '0:0': { value: 'latest', base: 'a' } },
        });
    });

    it('drains an admitted null clear before release transfers ownership', async () => {
        const file_path = '/tmp/pending-clear-release-drain.csv';
        const versioned = state_store({
            pendingEdits: { '0:0': { value: 'draft', base: 'a' } },
        });
        const clear_started = deferred();
        const clear_gate = deferred();
        const store: FileStateStore = {
            ...versioned.store,
            async compare_and_set(path, expected, next, validate) {
                if (!next.pendingEdits) {
                    clear_started.resolve();
                    await clear_gate.promise;
                }
                return versioned.store.compare_and_set(path, expected, next, validate);
            },
        };
        const owner = open_csv_table(uri(file_path), store);
        const sibling = open_csv_table(uri(file_path), store);
        await owner.__receive({ type: 'ready' });
        await sibling.__receive({ type: 'ready' });
        await owner.__receive({ type: 'requestEditSession', requestId: 'owner' });
        const session_id = latest_edit_session_message(owner)!.editSessionId!;

        const clear = owner.__receive({
            type: 'pendingEditsChanged',
            editSessionId: session_id,
            edits: null,
        });
        await clear_started.promise;
        const release = owner.__receive({
            type: 'releaseEditSession',
            editSessionId: session_id,
        });
        await sibling.__receive({ type: 'requestEditSession', requestId: 'blocked' });
        expect(edit_session_results(sibling).at(-1)?.granted).toBe(false);

        clear_gate.resolve();
        await Promise.all([clear, release]);
        expect(versioned.get_state(file_path).pendingEdits).toBeUndefined();
        await sibling.__receive({ type: 'requestEditSession', requestId: 'after-clear' });
        expect(edit_session_results(sibling).at(-1)).toEqual({
            type: 'editSessionResult',
            granted: true,
        });
    });

    it('keeps admitted pending persistence alive after panel disposal', async () => {
        const file_path = '/tmp/pending-disposal-drain.csv';
        const versioned = state_store();
        const compare_started = deferred();
        const compare_gate = deferred();
        const store: FileStateStore = {
            ...versioned.store,
            async compare_and_set(path, expected, next, validate) {
                if (next.pendingEdits) {
                    compare_started.resolve();
                    await compare_gate.promise;
                }
                return versioned.store.compare_and_set(path, expected, next, validate);
            },
        };
        const owner = open_csv_table(uri(file_path), store);
        const sibling = open_csv_table(uri(file_path), store);
        await owner.__receive({ type: 'ready' });
        await sibling.__receive({ type: 'ready' });
        await owner.__receive({ type: 'requestEditSession', requestId: 'owner' });
        const session_id = latest_edit_session_message(owner)!.editSessionId!;
        const pending = owner.__receive({
            type: 'pendingEditsChanged',
            editSessionId: session_id,
            edits: { '0:0': { value: 'survives-close', base: 'a' } },
        });
        await compare_started.promise;

        owner.dispose();
        await sibling.__receive({ type: 'requestEditSession', requestId: 'blocked' });
        expect(edit_session_results(sibling).at(-1)?.granted).toBe(false);
        compare_gate.resolve();
        await pending;
        await flush_promises();

        expect(versioned.get_state(file_path).pendingEdits).toEqual({
            '0:0': { value: 'survives-close', base: 'a' },
        });
        await sibling.__receive({ type: 'requestEditSession', requestId: 'after-close' });
        expect(edit_session_results(sibling).at(-1)?.granted).toBe(true);
    });

    it('drains multiple admitted pending maps in message order', async () => {
        const file_path = '/tmp/multiple-pending-release-drain.csv';
        const versioned = state_store();
        const first_started = deferred();
        const first_gate = deferred();
        let attempts = 0;
        const store: FileStateStore = {
            ...versioned.store,
            async compare_and_set(path, expected, next, validate) {
                attempts += 1;
                if (attempts === 1) {
                    first_started.resolve();
                    await first_gate.promise;
                }
                return versioned.store.compare_and_set(path, expected, next, validate);
            },
        };
        const owner = open_csv_table(uri(file_path), store);
        await owner.__receive({ type: 'ready' });
        await owner.__receive({ type: 'requestEditSession', requestId: 'owner' });
        const session_id = latest_edit_session_message(owner)!.editSessionId!;
        const first = owner.__receive({
            type: 'pendingEditsChanged', editSessionId: session_id,
            edits: { '0:0': { value: 'first', base: 'a' } },
        });
        await first_started.promise;
        const second = owner.__receive({
            type: 'pendingEditsChanged', editSessionId: session_id,
            edits: { '0:0': { value: 'second', base: 'a' } },
        });
        const release = owner.__receive({
            type: 'releaseEditSession', editSessionId: session_id,
        });
        await flush_promises();
        expect(attempts).toBe(1);

        first_gate.resolve();
        await Promise.all([first, second, release]);
        expect(attempts).toBe(2);
        expect(versioned.get_state(file_path).pendingEdits).toEqual({
            '0:0': { value: 'second', base: 'a' },
        });
    });

    it('releases ownership after admitted pending persistence rejects', async () => {
        const file_path = '/tmp/rejected-pending-release-drain.csv';
        const versioned = state_store();
        const compare_started = deferred();
        const compare_gate = deferred();
        const store: FileStateStore = {
            ...versioned.store,
            async compare_and_set() {
                compare_started.resolve();
                await compare_gate.promise;
                throw new Error('pending storage rejected');
            },
        };
        const owner = open_csv_table(uri(file_path), store);
        const sibling = open_csv_table(uri(file_path), store);
        await owner.__receive({ type: 'ready' });
        await sibling.__receive({ type: 'ready' });
        await owner.__receive({ type: 'requestEditSession', requestId: 'owner' });
        const session_id = latest_edit_session_message(owner)!.editSessionId!;
        const error = vi.spyOn(console, 'error').mockImplementation(() => {});
        const pending = owner.__receive({
            type: 'pendingEditsChanged', editSessionId: session_id,
            edits: { '0:0': { value: 'rejected', base: 'a' } },
        });
        await compare_started.promise;
        const release = owner.__receive({
            type: 'releaseEditSession', editSessionId: session_id,
        });
        compare_gate.resolve();
        await expect(pending).rejects.toThrow('pending storage rejected');
        await expect(release).resolves.toBeUndefined();
        expect(error).toHaveBeenCalledWith(
            'Failed to settle admitted CSV edits before release',
            expect.any(Error),
        );

        await sibling.__receive({ type: 'requestEditSession', requestId: 'after-rejection' });
        expect(edit_session_results(sibling).at(-1)?.granted).toBe(true);
    });

    it('settles accepted pending-edit persistence before writing a save', async () => {
        const file_path = '/tmp/settled-pending-before-save.csv';
        const versioned = state_store();
        const pending_started = deferred();
        const pending_gate = deferred();
        const write_started = deferred();
        const store: FileStateStore = {
            ...versioned.store,
            async compare_and_set(path, expected, next, validate) {
                if (next.pendingEdits) {
                    pending_started.resolve();
                    await pending_gate.promise;
                }
                return versioned.store.compare_and_set(path, expected, next, validate);
            },
        };
        vscode_mock.__setWriteFileImplementation(async () => {
            write_started.resolve();
        });
        const panel = open_csv_table(uri(file_path), store);
        await panel.__receive({ type: 'ready' });
        await panel.__receive({ type: 'requestEditSession' });

        const pending = panel.__receive({
            type: 'pendingEditsChanged',
            edits: { '0:0': { value: 'accepted', base: 'a' } },
        });
        await pending_started.promise;
        const save = panel.__receive({ type: 'saveCsv', edits: { '0:0': 'accepted' } });
        let wrote = false;
        void write_started.promise.then(() => { wrote = true; });
        await flush_promises();
        expect(wrote).toBe(false);

        pending_gate.resolve();
        await Promise.all([pending, save, write_started.promise]);
        expect(panel.__messages).toContainEqual(expect.objectContaining({ type: 'saveResult', success: true }));
    });

    it('keeps an accepted overlay save across ready and restores exact bases on write failure', async () => {
        const file_path = '/tmp/accepted-overlay-remount.csv';
        const versioned = state_store();
        const acceptance_started = deferred();
        const acceptance_gate = deferred();
        const stat = vi.fn(async () => ({ size: 4, mtime: 1 }));
        const read = vi.fn(async () => enc.encode('h\na\n'));
        const write = vi.fn(async () => { throw new Error('disk unavailable'); });
        const store: FileStateStore = {
            ...versioned.store,
            async compare_and_set(path, expected, next, validate) {
                if (next.pendingEdits?.['0:0'] && next.pendingEdits?.['0:1']) {
                    acceptance_started.resolve();
                    await acceptance_gate.promise;
                }
                return versioned.store.compare_and_set(path, expected, next, validate);
            },
        };
        vscode_mock.__setStatImplementation(stat);
        vscode_mock.__setReadFileImplementation(read);
        vscode_mock.__setWriteFileImplementation(write);
        const panel = open_csv_table(uri(file_path), store);
        await panel.__receive({ type: 'ready' });
        await panel.__receive({ type: 'requestEditSession', requestId: 'edit' });
        const edit_session_id = latest_edit_session_message(panel)!.editSessionId!;
        stat.mockClear();
        read.mockClear();

        const operation = {
            editSessionId: edit_session_id,
            saveRequestId: 'save-overlay',
            edits: { '0:0': 'overlay', '0:1': 'committed' },
            dirtyEdits: {
                '0:0': { value: 'overlay', base: 'overlay-base' },
                '0:1': { value: 'committed', base: 'committed-base' },
            },
        };
        const save = panel.__receive({ type: 'saveCsv', operation });
        await acceptance_started.promise;
        expect(stat).not.toHaveBeenCalled();
        expect(read).not.toHaveBeenCalled();
        expect(write).not.toHaveBeenCalled();

        await panel.__receive({ type: 'ready' });
        const remounted = latest_snapshot(panel) as ReturnType<typeof latest_snapshot> & {
            capabilities: { csvSaveLifecycle: { state: string; operation?: unknown } };
        };
        expect(remounted.capabilities.csvSaveLifecycle).toMatchObject({
            state: 'active',
            operation,
        });

        acceptance_gate.resolve();
        await save;

        expect(write).toHaveBeenCalledTimes(1);
        expect(versioned.get_state(file_path).pendingEdits).toEqual(operation.dirtyEdits);
        expect(panel.__messages).toContainEqual(expect.objectContaining({
            type: 'saveResult',
            success: false,
            lifecycle: expect.objectContaining({
                state: 'failed',
                operation,
            }),
        }));
    });

    it('retries exact acceptance after the last pending-edit write rejected', async () => {
        const file_path = '/tmp/rejected-pending-before-acceptance.csv';
        const versioned = state_store();
        let pending_attempts = 0;
        const write_started = deferred();
        const write_gate = deferred();
        const store: FileStateStore = {
            ...versioned.store,
            async compare_and_set(path, expected, next, validate) {
                if (next.pendingEdits) {
                    pending_attempts += 1;
                    if (pending_attempts === 1) {
                        throw new Error('earlier pending write failed');
                    }
                }
                return versioned.store.compare_and_set(path, expected, next, validate);
            },
        };
        vscode_mock.__setWriteFileImplementation(async () => {
            write_started.resolve();
            await write_gate.promise;
        });
        const panel = open_csv_table(uri(file_path), store);
        await panel.__receive({ type: 'ready' });
        await panel.__receive({ type: 'requestEditSession', requestId: 'edit' });
        const edit_session_id = latest_edit_session_message(panel)!.editSessionId!;
        await expect(panel.__receive({
            type: 'pendingEditsChanged',
            edits: { '0:0': { value: 'old', base: 'old-base' } },
        })).rejects.toThrow('earlier pending write failed');

        const operation = {
            editSessionId: edit_session_id,
            saveRequestId: 'retry-accepted-map',
            edits: { '0:0': 'exact' },
            dirtyEdits: { '0:0': { value: 'exact', base: 'exact-base' } },
        };
        const save = panel.__receive({ type: 'saveCsv', operation });
        await write_started.promise;

        expect(versioned.get_state(file_path).pendingEdits).toEqual(
            operation.dirtyEdits,
        );
        write_gate.resolve();
        await save;
    });

    it('ignores late pending-edit messages after save submission', async () => {
        const file_path = '/tmp/late-pending-after-save.csv';
        const original = { '0:0': { value: 'accepted', base: 'a' } };
        const state = state_store({ pendingEdits: original });
        const write_started = deferred();
        const write_gate = deferred();
        vscode_mock.__setWriteFileImplementation(async () => {
            write_started.resolve();
            await write_gate.promise;
        });
        const panel = open_csv_table(uri(file_path), state.store);
        await panel.__receive({ type: 'ready' });
        await panel.__receive({ type: 'requestEditSession' });

        const save = panel.__receive({ type: 'saveCsv', edits: { '0:0': 'accepted' } });
        await write_started.promise;
        await panel.__receive({
            type: 'pendingEditsChanged',
            edits: { '0:0': { value: 'too late', base: 'a' } },
        });
        expect(state.get_state(file_path).pendingEdits).toEqual(original);

        write_gate.resolve();
        await save;
        await flush_promises();
        expect(state.get_state(file_path).pendingEdits).toBeUndefined();
        expect(panel.__messages).toContainEqual(expect.objectContaining({ type: 'saveResult', success: true }));
    });

    it('retires succeeded lifecycle only after durable pending edits are cleared', async () => {
        const file_path = '/tmp/succeeded-lifecycle-cleanup.csv';
        const versioned = state_store();
        const cleanup_started = deferred();
        const cleanup_gate = deferred();
        const store: FileStateStore = {
            ...versioned.store,
            async compare_and_set(path, expected, next, validate) {
                const current = await versioned.store.read(path);
                if ((current.state as PerFileState).pendingEdits && !next.pendingEdits) {
                    cleanup_started.resolve();
                    await cleanup_gate.promise;
                }
                return versioned.store.compare_and_set(path, expected, next, validate);
            },
        };
        const panel = open_csv_table(uri(file_path), store);
        await panel.__receive({ type: 'ready' });
        await panel.__receive({ type: 'requestEditSession', requestId: 'edit' });
        const edit_session_id = latest_edit_session_message(panel)!.editSessionId!;
        await panel.__receive({
            type: 'saveCsv',
            operation: {
                editSessionId: edit_session_id,
                saveRequestId: 'save',
                edits: { '0:0': 'saved' },
                dirtyEdits: { '0:0': { value: 'saved', base: 'a' } },
            },
        });
        await cleanup_started.promise;
        panel.__messages.length = 0;
        await panel.__receive({ type: 'ready' });
        const pending = latest_snapshot(panel) as ReturnType<typeof latest_snapshot> & {
            capabilities: { csvSaveLifecycle: { revision: number; state: string } };
        };
        expect(pending.capabilities.csvSaveLifecycle.state).toBe('succeeded');
        expect(pending.state.pendingEdits).toBeUndefined();

        cleanup_gate.resolve();
        await flush_promises();
        panel.__messages.length = 0;
        await panel.__receive({ type: 'ready' });
        const cleared = latest_snapshot(panel) as typeof pending;
        expect(cleared.state.pendingEdits).toBeUndefined();
        expect(cleared.capabilities.csvSaveLifecycle).toEqual({
            revision: pending.capabilities.csvSaveLifecycle.revision + 1,
            state: 'idle',
        });
    });

    it('retires a failed save after newer pending edits are accepted', async () => {
        const file_path = '/tmp/failed-save-newer-pending.csv';
        const versioned = state_store();
        vscode_mock.__setWriteFileImplementation(async () => {
            throw new Error('write failed');
        });
        const panel = open_csv_table(uri(file_path), versioned.store);
        await panel.__receive({ type: 'ready' });
        await panel.__receive({ type: 'requestEditSession', requestId: 'edit-a' });
        const edit_session_id = latest_edit_session_message(panel)!.editSessionId!;
        await panel.__receive({
            type: 'saveCsv',
            operation: {
                editSessionId: edit_session_id,
                saveRequestId: 'save-a',
                edits: { '0:0': 'A' },
                dirtyEdits: { '0:0': { value: 'A', base: 'a' } },
            },
        });
        const failed = [...panel.__messages].reverse().find((message) => (
            typeof message === 'object'
            && message !== null
            && 'type' in message
            && message.type === 'saveResult'
        )) as { lifecycle: { revision: number; state: string } };
        expect(failed.lifecycle.state).toBe('failed');

        const newer = { '0:0': { value: 'B', base: 'a' } };
        await panel.__receive({
            type: 'pendingEditsChanged',
            editSessionId: edit_session_id,
            edits: newer,
        });
        panel.__messages.length = 0;
        await panel.__receive({ type: 'ready' });
        const snapshot = latest_snapshot(panel) as ReturnType<typeof latest_snapshot> & {
            capabilities: { csvSaveLifecycle: { revision: number; state: string } };
        };
        expect(snapshot.state.pendingEdits).toEqual(newer);
        expect(snapshot.capabilities.csvSaveLifecycle).toEqual({
            revision: failed.lifecycle.revision + 1,
            state: 'idle',
        });
    });

    it('keeps a failed operation as a tombstone outside its original session', async () => {
        const file_path = '/tmp/failed-save-later-session.csv';
        const versioned = state_store();
        vscode_mock.__setWriteFileImplementation(async () => {
            throw new Error('write failed');
        });
        const panel = open_csv_table(uri(file_path), versioned.store);
        await panel.__receive({ type: 'ready' });
        await panel.__receive({ type: 'requestEditSession', requestId: 'session-a' });
        const session_a = latest_edit_session_message(panel)!.editSessionId!;
        await panel.__receive({
            type: 'saveCsv',
            operation: {
                editSessionId: session_a,
                saveRequestId: 'failed-a',
                edits: { '0:0': 'A' },
                dirtyEdits: { '0:0': { value: 'A', base: 'a' } },
            },
        });
        await panel.__receive({
            type: 'releaseEditSession',
            editSessionId: session_a,
        });
        await panel.__receive({ type: 'requestEditSession', requestId: 'session-b' });
        const grant_b = latest_edit_session_message(panel)!;
        const session_b = grant_b.editSessionId!;
        expect(session_b).not.toBe(session_a);
        expect(grant_b.pendingEdits).toBeUndefined();
        panel.__messages.length = 0;
        await panel.__receive({ type: 'ready' });
        const snapshot = latest_snapshot(panel) as ReturnType<typeof latest_snapshot> & {
            capabilities: {
                csvEditSessionId?: string;
                csvSaveLifecycle: { state: string; operation?: { editSessionId: string } };
            };
        };
        expect(snapshot.capabilities.csvEditSessionId).toBe(session_b);
        expect(snapshot.state.pendingEdits).toBeUndefined();
        expect(snapshot.capabilities.csvSaveLifecycle).toMatchObject({ state: 'idle' });
        expect(snapshot.capabilities.csvSaveLifecycle.operation).toBeUndefined();
        expect(versioned.get_state(file_path).pendingEdits).toBeUndefined();

        const newer = { '0:0': { value: 'B', base: 'a' } };
        await panel.__receive({
            type: 'pendingEditsChanged',
            editSessionId: session_b,
            edits: newer,
        });
        panel.__messages.length = 0;
        await panel.__receive({ type: 'ready' });
        const superseded = latest_snapshot(panel) as typeof snapshot;
        expect(superseded.state.pendingEdits).toEqual(newer);
        expect(superseded.capabilities.csvSaveLifecycle).toMatchObject({ state: 'idle' });
    });

    it('does not hydrate a failed save tombstone into a later panel session', async () => {
        const file_path = '/tmp/cross-panel-edit-session-id-collision.csv';
        const versioned = state_store();
        let reject_cleanup = false;
        const store: FileStateStore = {
            ...versioned.store,
            async compare_and_set(path, expected, next, validate) {
                if (reject_cleanup && !next.pendingEdits) {
                    throw new Error('retired save cleanup rejected');
                }
                return versioned.store.compare_and_set(path, expected, next, validate);
            },
        };
        vscode_mock.__setWriteFileImplementation(async () => {
            throw new Error('save write rejected');
        });
        const first = open_csv_table(uri(file_path), store);
        const second = open_csv_table(uri(file_path), store);
        await first.__receive({ type: 'ready' });
        await second.__receive({ type: 'ready' });
        await first.__receive({ type: 'requestEditSession', requestId: 'first' });
        const first_session = latest_edit_session_message(first)!.editSessionId!;
        const failed_map = { '0:0': { value: 'panel-a', base: 'a' } };
        await first.__receive({
            type: 'saveCsv',
            operation: {
                editSessionId: first_session,
                saveRequestId: 'panel-a-failed-save',
                edits: { '0:0': 'panel-a' },
                dirtyEdits: failed_map,
            },
        });
        expect(versioned.get_state(file_path).pendingEdits).toEqual(failed_map);

        reject_cleanup = true;
        const error = vi.spyOn(console, 'error').mockImplementation(() => {});
        await first.__receive({
            type: 'releaseEditSession',
            editSessionId: first_session,
        });
        await flush_promises();
        expect(error).toHaveBeenCalledWith(
            'Failed to clear retired CSV save state',
            expect.any(Error),
        );

        await second.__receive({ type: 'requestEditSession', requestId: 'second' });
        const second_grant = latest_edit_session_message(second)!;
        expect(second_grant.granted).toBe(true);
        expect(second_grant.editSessionId).not.toBe(first_session);
        expect(second_grant.pendingEdits).toBeUndefined();
    });

    it('suppresses the cleanup-failure warning when the saving panel is disposed', async () => {
        // A save promise outlives its panel: after the disk write, durable cleanup
        // stays pinned even once the tab closes. But its user-facing warning must
        // not fire for an editor the user already closed.
        const file_path = '/tmp/disposed-save-cleanup-warning.csv';
        const pendingEdits = { '0:0': { value: 'saved', base: 'a' } };
        const versioned = state_store({ pendingEdits });
        const cleanup_started = deferred();
        const cleanup_gate = deferred();
        let bytes = enc.encode('h\na\n');
        vscode_mock.__setStatImplementation(async () => ({ size: bytes.byteLength, mtime: 1 }));
        vscode_mock.__setReadFileImplementation(async () => bytes);
        vscode_mock.__setWriteFileImplementation(async (_uri, content) => {
            bytes = new Uint8Array(content);
        });
        const store: FileStateStore = {
            ...versioned.store,
            async compare_and_set(path, expected, next, validate) {
                const current = await versioned.store.read(path);
                if ((current.state as PerFileState).pendingEdits && !next.pendingEdits) {
                    // Suspend the post-write cleanup so the panel can be disposed
                    // before it fails, then fail it.
                    cleanup_started.resolve();
                    await cleanup_gate.promise;
                    throw new Error('cleanup storage failed');
                }
                return versioned.store.compare_and_set(path, expected, next, validate);
            },
        };
        const warning = vi.spyOn(vscode_mock.window, 'showWarningMessage');
        const panel = open_csv_table(uri(file_path), store);
        await panel.__receive({ type: 'ready' });
        await panel.__receive({ type: 'requestEditSession' });
        await panel.__receive({ type: 'saveCsv', edits: { '0:0': 'saved' } });
        await cleanup_started.promise;
        await flush_promises();

        // Disk write already succeeded; only the pinned cleanup remains.
        expect(panel.__messages).toContainEqual(expect.objectContaining({ type: 'saveResult', success: true }));
        warning.mockClear();
        panel.dispose();
        cleanup_gate.resolve();
        await flush_promises();

        // The cleanup CAS threw, but the owning panel is gone: no popup fires.
        expect(warning).not.toHaveBeenCalled();
        // The durable edit remains uncleared, exactly as in the non-disposed case.
        expect(versioned.get_state(file_path).pendingEdits).toEqual(pendingEdits);
    });

    it('keeps disk success while a pending-edit cleanup failure disables editing', async () => {
        const file_path = '/tmp/save-cleanup-failure.csv';
        const pendingEdits = { '0:0': { value: 'saved', base: 'a' } };
        const versioned = state_store({ pendingEdits });
        let bytes = enc.encode('h\na\n');
        vscode_mock.__setStatImplementation(async () => ({ size: bytes.byteLength, mtime: 1 }));
        vscode_mock.__setReadFileImplementation(async () => bytes);
        vscode_mock.__setWriteFileImplementation(async (_uri, content) => {
            bytes = new Uint8Array(content);
        });
        const store: FileStateStore = {
            ...versioned.store,
            async compare_and_set(path, expected, next, validate) {
                const current = await versioned.store.read(path);
                if ((current.state as PerFileState).pendingEdits && !next.pendingEdits) {
                    throw new Error('cleanup storage failed');
                }
                return versioned.store.compare_and_set(path, expected, next, validate);
            },
        };
        const warning = vi.spyOn(vscode_mock.window, 'showWarningMessage');
        const panel = open_csv_table(uri(file_path), store);
        const peer = open_csv_table(uri(file_path), store);
        await panel.__receive({ type: 'ready' });
        await peer.__receive({ type: 'ready' });
        await panel.__receive({ type: 'requestEditSession' });

        await panel.__receive({ type: 'saveCsv', edits: { '0:0': 'saved' } });
        await flush_promises();
        await peer.__receive({ type: 'requestEditSession' });
        await panel.__receive({ type: 'ready' });

        expect(panel.__messages).toContainEqual(expect.objectContaining({ type: 'saveResult', success: true }));
        expect(warning).toHaveBeenCalledWith(expect.stringContaining('file was saved'));
        expect(edit_session_results(peer).at(-1)).toEqual({
            type: 'editSessionResult',
            granted: false,
        });
        expect(latest_snapshot(panel).state.pendingEdits).toBeUndefined();
        expect(versioned.get_state(file_path).pendingEdits).toEqual(pendingEdits);
    });

    it('reports disk success before stalled cleanup and refresh, then blocks every panel', async () => {
        const file_path = '/tmp/stalled-save-followup.csv';
        const pendingEdits = { '0:0': { value: 'saved', base: 'a' } };
        const versioned = state_store({ pendingEdits });
        const cleanup_started = deferred();
        const cleanup_gate = deferred();
        let builds = 0;
        let bytes = enc.encode('h\na\n');
        vscode_mock.__setStatImplementation(async () => ({ size: bytes.byteLength, mtime: 1 }));
        vscode_mock.__setReadFileImplementation(async () => bytes);
        vscode_mock.__setWriteFileImplementation(async (_uri, content) => {
            bytes = new Uint8Array(content);
        });
        const store: FileStateStore = {
            ...versioned.store,
            async compare_and_set(path, expected, next, validate) {
                const current = await versioned.store.read(path);
                if ((current.state as PerFileState).pendingEdits && !next.pendingEdits) {
                    cleanup_started.resolve();
                    await cleanup_gate.promise;
                }
                return versioned.store.compare_and_set(path, expected, next, validate);
            },
        };
        const profile: ViewerProfile = {
            editing: true,
            async build_source(raw, path) {
                builds += 1;
                if (builds > 1) return new Promise<DataSource>(() => {});
                return csv_table_profile().build_source(raw, path, {});
            },
        };
        const owner = open_csv_table(uri(file_path), store, profile);
        const peer = open_csv_table(uri(file_path), store);
        await owner.__receive({ type: 'ready' });
        await peer.__receive({ type: 'ready' });
        await owner.__receive({ type: 'requestEditSession' });

        await owner.__receive({ type: 'saveCsv', edits: { '0:0': 'saved' } });
        await cleanup_started.promise;
        await flush_promises();

        expect(owner.__messages).toContainEqual(expect.objectContaining({
            type: 'editSessionRevoked',
            reason: 'saved',
        }));
        expect(owner.__messages.filter((message: any) => message?.type === 'saveResult'))
            .toEqual([expect.objectContaining({ type: 'saveResult', success: true })]);
        const peer_refresh = [...peer.__messages].reverse().find((message: any) => (
            message?.type === 'workbookSnapshot'
            && message.snapshot.presentation === 'refresh'
        )) as { snapshot?: { capabilities?: { csvEditable?: boolean } } } | undefined;
        expect(peer_refresh?.snapshot?.capabilities?.csvEditable).toBe(false);
        await peer.__receive({ type: 'requestEditSession' });
        expect(edit_session_results(peer).at(-1)?.granted).toBe(false);
        await owner.__receive({
            type: 'pendingEditsChanged',
            edits: { '0:0': { value: 'stale', base: 'a' } },
        });
        expect(versioned.get_state(file_path).pendingEdits).toEqual(pendingEdits);
    });

    it('recovers uncertain cleanup before another panel can claim', async () => {
        const file_path = '/tmp/recover-save-cleanup.csv';
        const pendingEdits = { '0:0': { value: 'saved', base: 'a' } };
        const versioned = state_store({ pendingEdits });
        let fail_cleanup = true;
        let bytes = enc.encode('h\na\n');
        vscode_mock.__setStatImplementation(async () => ({ size: bytes.byteLength, mtime: 1 }));
        vscode_mock.__setReadFileImplementation(async () => bytes);
        vscode_mock.__setWriteFileImplementation(async (_uri, content) => {
            bytes = new Uint8Array(content);
        });
        const store: FileStateStore = {
            ...versioned.store,
            async compare_and_set(path, expected, next, validate) {
                const current = await versioned.store.read(path);
                if (
                    fail_cleanup
                    && (current.state as PerFileState).pendingEdits
                    && !next.pendingEdits
                ) {
                    throw new Error('cleanup failed once');
                }
                return versioned.store.compare_and_set(path, expected, next, validate);
            },
        };
        const owner = open_csv_table(uri(file_path), store);
        const peer = open_csv_table(uri(file_path), store);
        await owner.__receive({ type: 'ready' });
        await peer.__receive({ type: 'ready' });
        await owner.__receive({ type: 'requestEditSession' });
        await owner.__receive({ type: 'saveCsv', edits: { '0:0': 'saved' } });
        await flush_promises();

        fail_cleanup = false;
        await peer.__receive({ type: 'requestEditSession' });

        expect(edit_session_results(peer).at(-1)).toEqual({
            type: 'editSessionResult',
            granted: true,
        });
        const grant_index = peer.__messages.map((message: any) => (
            message?.type === 'editSessionResult' && message.granted === true
        )).lastIndexOf(true);
        const capability_index = peer.__messages.map((message: any) => (
            message?.type === 'workbookSnapshot'
            && message.snapshot.capabilities.csvEditable === true
        )).lastIndexOf(true);
        expect(capability_index).toBeGreaterThanOrEqual(0);
        expect(capability_index).toBeLessThan(grant_index);
        expect(versioned.get_state(file_path).pendingEdits).toBeUndefined();
    });

    it('denies a timed-out recovery waiter and lets a sibling claim after late cleanup', async () => {
        vi.useFakeTimers();
        const file_path = '/tmp/timed-out-cleanup-waiter.csv';
        const pendingEdits = { '0:0': { value: 'saved', base: 'a' } };
        const cleanup = uncertain_cleanup_store({ pendingEdits });
        const owner = open_csv_table(uri(file_path), cleanup.store);
        const timed_out = open_csv_table(uri(file_path), cleanup.store);
        const sibling = open_csv_table(uri(file_path), cleanup.store);
        await owner.__receive({ type: 'ready' });
        await timed_out.__receive({ type: 'ready' });
        await sibling.__receive({ type: 'ready' });
        await owner.__receive({ type: 'requestEditSession' });
        await owner.__receive({ type: 'saveCsv', edits: { '0:0': 'saved' } });
        await flush_promises();

        const first_request = timed_out.__receive({ type: 'requestEditSession' });
        await cleanup.recovery_started.promise;
        await vi.advanceTimersByTimeAsync(250);
        await first_request;
        expect(edit_session_results(timed_out).at(-1)?.granted).toBe(false);

        cleanup.recovery_gate.resolve();
        await flush_promises();
        expect(edit_session_results(timed_out).some((result) => result.granted)).toBe(false);
        await sibling.__receive({ type: 'requestEditSession' });
        expect(edit_session_results(sibling).at(-1)?.granted).toBe(true);
        vi.useRealTimers();
    });

    it('leaves recovery free when its requester is disposed', async () => {
        const file_path = '/tmp/disposed-cleanup-waiter.csv';
        const pendingEdits = { '0:0': { value: 'saved', base: 'a' } };
        const cleanup = uncertain_cleanup_store({ pendingEdits });
        const owner = open_csv_table(uri(file_path), cleanup.store);
        const disposed_waiter = open_csv_table(uri(file_path), cleanup.store);
        const survivor = open_csv_table(uri(file_path), cleanup.store);
        await owner.__receive({ type: 'ready' });
        await disposed_waiter.__receive({ type: 'ready' });
        await survivor.__receive({ type: 'ready' });
        await owner.__receive({ type: 'requestEditSession' });
        await owner.__receive({ type: 'saveCsv', edits: { '0:0': 'saved' } });
        await flush_promises();

        const request = disposed_waiter.__receive({ type: 'requestEditSession' });
        await cleanup.recovery_started.promise;
        disposed_waiter.dispose();
        await request;
        cleanup.recovery_gate.resolve();
        await flush_promises();

        await survivor.__receive({ type: 'requestEditSession' });
        expect(edit_session_results(survivor).at(-1)?.granted).toBe(true);
        expect(edit_session_results(disposed_waiter).some((result) => result.granted)).toBe(false);
    });

    it('deletes free shared edit state after the last recovery attachment disposes', async () => {
        const file_path = '/tmp/last-attachment-recovery-cleanup.csv';
        const cleanup = uncertain_cleanup_store({
            pendingEdits: { '0:0': { value: 'saved', base: 'a' } },
        });
        const owner = open_csv_table(uri(file_path), cleanup.store);
        await owner.__receive({ type: 'ready' });
        await owner.__receive({ type: 'requestEditSession', requestId: 'owner' });
        await owner.__receive({ type: 'saveCsv', edits: { '0:0': 'saved' } });
        await flush_promises();

        const recovery = owner.__receive({
            type: 'requestEditSession',
            requestId: 'recovering-owner',
        });
        await cleanup.recovery_started.promise;
        owner.dispose();
        await recovery;
        cleanup.recovery_gate.resolve();
        await flush_promises();

        // A fresh store for the same path makes a leaked clearedStateRevision
        // observable: the new revision-zero pending map would be hidden.
        const fresh_pending = { '0:0': { value: 'fresh', base: 'fresh-base' } };
        const fresh = state_store({ pendingEdits: fresh_pending });
        const replacement = open_csv_table(uri(file_path), fresh.store);
        await replacement.__receive({ type: 'ready' });
        await replacement.__receive({
            type: 'requestEditSession',
            requestId: 'replacement',
        });
        const grant = latest_edit_session_message(replacement)!;
        expect(grant.granted).toBe(true);
        expect(grant.pendingEdits).toEqual(fresh_pending);
    });

    it('allows exactly one live waiter to claim a shared cleanup recovery', async () => {
        const file_path = '/tmp/shared-cleanup-waiters.csv';
        const pendingEdits = { '0:0': { value: 'saved', base: 'a' } };
        const cleanup = uncertain_cleanup_store({ pendingEdits });
        const owner = open_csv_table(uri(file_path), cleanup.store);
        const first = open_csv_table(uri(file_path), cleanup.store);
        const second = open_csv_table(uri(file_path), cleanup.store);
        await owner.__receive({ type: 'ready' });
        await first.__receive({ type: 'ready' });
        await second.__receive({ type: 'ready' });
        await owner.__receive({ type: 'requestEditSession' });
        await owner.__receive({ type: 'saveCsv', edits: { '0:0': 'saved' } });
        await flush_promises();

        const first_request = first.__receive({ type: 'requestEditSession' });
        const second_request = second.__receive({ type: 'requestEditSession' });
        await cleanup.recovery_started.promise;
        cleanup.recovery_gate.resolve();
        await Promise.all([first_request, second_request]);

        const granted = [first, second].filter((panel) => (
            edit_session_results(panel).at(-1)?.granted === true
        ));
        expect(granted).toHaveLength(1);
        expect(edit_session_results(first).at(-1)?.granted).toBe(true);
        expect(edit_session_results(second).at(-1)?.granted).toBe(false);
    });

    it('lets a timed-out panel retry after late recovery leaves the file free', async () => {
        vi.useFakeTimers();
        const file_path = '/tmp/retry-cleanup-waiter.csv';
        const pendingEdits = { '0:0': { value: 'saved', base: 'a' } };
        const cleanup = uncertain_cleanup_store({ pendingEdits });
        const owner = open_csv_table(uri(file_path), cleanup.store);
        const waiter = open_csv_table(uri(file_path), cleanup.store);
        await owner.__receive({ type: 'ready' });
        await waiter.__receive({ type: 'ready' });
        await owner.__receive({ type: 'requestEditSession' });
        await owner.__receive({ type: 'saveCsv', edits: { '0:0': 'saved' } });
        await flush_promises();

        const first_request = waiter.__receive({ type: 'requestEditSession' });
        await cleanup.recovery_started.promise;
        await vi.advanceTimersByTimeAsync(250);
        await first_request;
        expect(edit_session_results(waiter).at(-1)?.granted).toBe(false);
        cleanup.recovery_gate.resolve();
        await flush_promises();

        await waiter.__receive({ type: 'requestEditSession' });
        expect(edit_session_results(waiter).at(-1)?.granted).toBe(true);
        vi.useRealTimers();
    });

    it('releases ownership when a disposed accepted save ends in an external conflict', async () => {
        const file_path = '/tmp/disposed-accepted-conflict.csv';
        const versioned = state_store();
        const verification_started = deferred();
        const verification_gate = deferred();
        let bytes = enc.encode('h\na\n');
        let gate_verification = false;
        vscode_mock.__setStatImplementation(async () => ({ size: bytes.byteLength, mtime: 1 }));
        vscode_mock.__setReadFileImplementation(async () => {
            if (gate_verification) {
                gate_verification = false;
                verification_started.resolve();
                await verification_gate.promise;
            }
            return bytes;
        });
        const owner = open_csv_table(uri(file_path), versioned.store);
        const peer = open_csv_table(uri(file_path), versioned.store);
        await owner.__receive({ type: 'ready' });
        await peer.__receive({ type: 'ready' });
        await owner.__receive({ type: 'requestEditSession', requestId: 'owner-edit' });
        const edit_session_id = latest_edit_session_message(owner)!.editSessionId!;

        gate_verification = true;
        const save = owner.__receive({
            type: 'saveCsv',
            operation: {
                editSessionId: edit_session_id,
                saveRequestId: 'accepted-before-dispose',
                edits: { '0:0': 'saved' },
                dirtyEdits: { '0:0': { value: 'saved', base: 'a' } },
            },
        });
        await verification_started.promise;
        expect(versioned.get_state(file_path).pendingEdits).toEqual({
            '0:0': { value: 'saved', base: 'a' },
        });

        owner.dispose();
        bytes = enc.encode('h\nb\n');
        verification_gate.resolve();
        await save;

        await peer.__receive({ type: 'requestEditSession', requestId: 'peer-edit' });
        expect(edit_session_results(peer).at(-1)).toEqual({
            type: 'editSessionResult',
            granted: true,
        });
        expect(versioned.get_state(file_path).pendingEdits).toBeUndefined();
    });

    it('finishes file cleanup after the saving owner is disposed', async () => {
        const file_path = '/tmp/disposed-owner-cleanup.csv';
        const pendingEdits = { '0:0': { value: 'saved', base: 'a' } };
        const versioned = state_store({ pendingEdits });
        const cleanup_started = deferred();
        const cleanup_gate = deferred();
        let bytes = enc.encode('h\na\n');
        let file_reads = 0;
        vscode_mock.__setStatImplementation(async () => ({ size: bytes.byteLength, mtime: 1 }));
        vscode_mock.__setReadFileImplementation(async () => {
            file_reads += 1;
            return bytes;
        });
        vscode_mock.__setWriteFileImplementation(async (_uri, content) => {
            bytes = new Uint8Array(content);
        });
        const store: FileStateStore = {
            ...versioned.store,
            async compare_and_set(path, expected, next, validate) {
                const current = await versioned.store.read(path);
                if ((current.state as PerFileState).pendingEdits && !next.pendingEdits) {
                    cleanup_started.resolve();
                    await cleanup_gate.promise;
                }
                return versioned.store.compare_and_set(path, expected, next, validate);
            },
        };
        const owner = open_csv_table(uri(file_path), store);
        const peer = open_csv_table(uri(file_path), store);
        await owner.__receive({ type: 'ready' });
        await peer.__receive({ type: 'ready' });
        await owner.__receive({ type: 'requestEditSession' });
        await owner.__receive({ type: 'saveCsv', edits: { '0:0': 'saved' } });
        await cleanup_started.promise;
        await flush_promises();
        const blocked = [...peer.__messages].reverse().find((message: any) => (
            message?.type === 'workbookSnapshot'
            && message.snapshot.capabilities.csvEditable === false
        )) as { snapshot: {
            generation: number;
            sourceGeneration: number;
            identity: WorkbookSnapshotIdentity;
        } };
        const owner_messages_before_dispose = owner.__messages.length;
        const reads_before_cleanup_completion = file_reads;
        owner.dispose();

        await peer.__receive({ type: 'requestEditSession' });
        expect(edit_session_results(peer).at(-1)?.granted).toBe(false);
        cleanup_gate.resolve();
        await flush_promises();
        const available = [...peer.__messages].reverse().find((message: any) => (
            message?.type === 'workbookSnapshot'
            && message.snapshot.capabilities.csvEditable === true
            && message.snapshot.presentation === 'refresh'
        )) as typeof blocked;
        expect(available.snapshot.generation).toBe(blocked.snapshot.generation);
        expect(available.snapshot.sourceGeneration).toBe(blocked.snapshot.sourceGeneration);
        expect(available.snapshot.identity.sourceBasis).toEqual(
            blocked.snapshot.identity.sourceBasis,
        );
        expect(file_reads).toBe(reads_before_cleanup_completion);
        expect(owner.__messages).toHaveLength(owner_messages_before_dispose);

        await peer.__receive({ type: 'requestEditSession' });
        expect(edit_session_results(peer).at(-1)?.granted).toBe(true);
        expect(versioned.get_state(file_path).pendingEdits).toBeUndefined();
    });

    it('does not resurrect cleared pending edits from a later visibility snapshot', async () => {
        const file_path = '/tmp/cleared-edits-visibility.csv';
        const restored = { '0:0': { value: 'draft', base: 'a' } };
        const state = state_store({ pendingEdits: restored });
        const panel = open_csv_table(uri(file_path), state.store);
        await panel.__receive({ type: 'ready' });
        await panel.__receive({ type: 'requestEditSession' });
        expect(edit_session_results(panel).at(-1)?.granted).toBe(true);

        await panel.__receive({ type: 'pendingEditsChanged', edits: null } as never);
        expect(state.get_state(file_path).pendingEdits).toBeUndefined();

        await panel.__receive({
            type: 'setColumnVisibility',
            sheetIndex: 0,
            sheetName: 'Sheet1',
            sourceGeneration: 1,
            state: { visibleColumns: [], schema: '["Sheet1",1,["h"]]' },
        } as never);
        await panel.__receive({
            type: 'stateChanged',
            sourceGeneration: 1,
            snapshotIdentity: initial_snapshot(panel).identity,
            state: {
                pendingEdits: restored,
                columnVisibility: [undefined],
            },
        } as never);

        expect(state.get_state(file_path).pendingEdits).toBeUndefined();
        expect(state.get_state(file_path).columnVisibility).toEqual([{
            visibleColumns: [],
            schema: '["Sheet1",1,["h"]]',
        }]);
    });

    it('preserves a newer direct visibility choice after another panel posts delayed reload cleanup', async () => {
        const file_path = '/tmp/two-panel-visibility.csv';
        const state = state_store();
        const first = open_csv_table(uri(file_path), state.store);
        const second = open_csv_table(uri(file_path), state.store);
        await first.__receive({ type: 'ready' });
        await second.__receive({ type: 'ready' });
        const schema = '["Sheet1",1,["h"]]';
        const second_identity = initial_snapshot(second).identity;

        // The second tab captures stale state for refresh cleanup, but its generic
        // persistence reaches the host only after the first tab's direct user choice.
        const cleanup_gate = deferred();
        const delayed_cleanup = cleanup_gate.promise.then(() => second.__receive({
            type: 'stateChanged', sourceGeneration: 1,
            snapshotIdentity: second_identity,
            state: { columnVisibility: [undefined], activeSheetIndex: 0 },
        } as never));
        await first.__receive({
            type: 'setColumnVisibility', sheetIndex: 0, sheetName: 'Sheet1',
            sourceGeneration: 1, state: { visibleColumns: [], schema },
        } as never);
        cleanup_gate.resolve();
        await delayed_cleanup;
        expect(state.get_state(file_path).columnVisibility).toEqual([{
            visibleColumns: [], schema,
        }]);

        await first.__receive({
            type: 'setColumnVisibility', sheetIndex: 0, sheetName: 'Sheet1',
            sourceGeneration: 1, state: undefined,
        } as never);
        await second.__receive({
            type: 'stateChanged', sourceGeneration: 1,
            snapshotIdentity: second_identity,
            state: {
                columnVisibility: [{ visibleColumns: [], schema }], activeSheetIndex: 0,
            },
        } as never);
        expect(state.get_state(file_path).columnVisibility).toEqual([undefined]);
    });

    it('cancels an old receiver visibility write before it can commit', async () => {
        const file_path = '/tmp/obsolete-receiver-visibility.csv';
        const versioned = state_store();
        const stale_read_started = deferred();
        const stale_read_gate = deferred();
        let block_next_read = false;
        let compare_attempts = 0;
        const store: FileStateStore = {
            ...versioned.store,
            async read(path) {
                const snapshot = await versioned.store.read(path);
                if (block_next_read) {
                    block_next_read = false;
                    stale_read_started.resolve();
                    await stale_read_gate.promise;
                }
                return snapshot;
            },
            async compare_and_set(path, expected, next, validate) {
                compare_attempts += 1;
                return versioned.store.compare_and_set(path, expected, next, validate);
            },
        };
        const panel = open_csv_table(uri(file_path), store);
        await panel.__receive({ type: 'ready' });
        const old_receiver = latest_snapshot(panel);

        block_next_read = true;
        const visibility = panel.__receive({
            type: 'setColumnVisibility',
            sheetIndex: 0,
            sheetName: 'Sheet1',
            sourceGeneration: old_receiver.sourceGeneration,
            snapshotIdentity: old_receiver.identity,
            state: { visibleColumns: [], schema: '["Sheet1",1,["h"]]' },
        });
        await stale_read_started.promise;
        const replacement_ready = panel.__receive({ type: 'ready' });
        stale_read_gate.resolve();
        await Promise.all([visibility, replacement_ready]);

        expect(compare_attempts).toBe(0);
        expect(versioned.revision(file_path)).toBe(0);
        expect(versioned.get_state(file_path).columnVisibility).toBeUndefined();
    });

    it('rebases a transform-blocked replacement ready and cancels a conflicting old visibility retry', async () => {
        const file_path = '/tmp/ready-visibility-conflict-rebase.csv';
        const versioned = state_store();
        const visibility_cas_started = deferred();
        const visibility_cas_gate = deferred();
        const stale_ready_read_started = deferred();
        const stale_ready_read_gate = deferred();
        let block_visibility_cas = true;
        let capture_ready_read = false;
        let visibility_conflicts = 0;
        let visibility_compare_attempts = 0;
        const store: FileStateStore = {
            ...versioned.store,
            async read(path) {
                const snapshot = await versioned.store.read(path);
                if (capture_ready_read) {
                    capture_ready_read = false;
                    stale_ready_read_started.resolve();
                    await stale_ready_read_gate.promise;
                }
                return snapshot;
            },
            async compare_and_set(path, expected, next, validate) {
                if (next.columnVisibility?.[0] && block_visibility_cas) {
                    block_visibility_cas = false;
                    visibility_compare_attempts += 1;
                    visibility_cas_started.resolve();
                    await visibility_cas_gate.promise;
                    const result = await versioned.store.compare_and_set(
                        path,
                        expected,
                        next,
                        validate,
                    );
                    if (result.type === 'conflict') visibility_conflicts += 1;
                    return result;
                }
                if (next.columnVisibility?.[0]) visibility_compare_attempts += 1;
                return versioned.store.compare_and_set(path, expected, next, validate);
            },
        };
        const receiver = open_csv_table(uri(file_path), store);
        const actor = open_csv_table(uri(file_path), store);
        await receiver.__receive({ type: 'ready' });
        await actor.__receive({ type: 'ready' });
        await receiver.__receive({ type: 'requestEditSession', requestId: 'owner' });
        await flush_promises();
        const old_receiver = latest_snapshot(receiver);
        const actor_snapshot = latest_snapshot(actor);

        const visibility = receiver.__receive({
            type: 'setColumnVisibility',
            sheetIndex: 0,
            sheetName: 'Sheet1',
            sourceGeneration: old_receiver.sourceGeneration,
            snapshotIdentity: old_receiver.identity,
            state: { visibleColumns: [], schema: '["Sheet1",1,["h"]]' },
        });
        await visibility_cas_started.promise;

        capture_ready_read = true;
        const replacement_ready = receiver.__receive({ type: 'ready' });
        await stale_ready_read_started.promise;
        await actor.__receive({
            type: 'stateChanged',
            sourceGeneration: actor_snapshot.sourceGeneration,
            snapshotIdentity: actor_snapshot.identity,
            state: { ...actor_snapshot.state, rowHeights: [{ 0: 41 }] },
        });
        expect(versioned.revision(file_path)).toBe(1);

        visibility_cas_gate.resolve();
        await visibility;
        stale_ready_read_gate.resolve();
        await replacement_ready;

        expect(visibility_conflicts).toBe(1);
        expect(visibility_compare_attempts).toBe(1);
        expect(versioned.revision(file_path)).toBe(1);
        expect(versioned.get_state(file_path).columnVisibility).toEqual([]);
        expect(versioned.get_state(file_path).rowHeights).toEqual([{ 0: 41 }]);
        expect(latest_snapshot(receiver).state.rowHeights).toEqual([{ 0: 41 }]);
        expect(latest_snapshot(receiver).state.columnVisibility).toEqual([undefined]);
    });

    it('durably removes host-owned transforms that no longer match the source schema', async () => {
        const file_path = '/tmp/stale-transform-schema.csv';
        const stale_transform = {
            sort: [{ colIndex: 0, direction: 'asc' as const }],
            filters: [],
            schema: '["Old sheet",99,null]',
        };
        const state = state_store({ transforms: [stale_transform] });
        const panel = open_csv_table(uri(file_path), state.store);
        await panel.__receive({ type: 'ready' });
        const snapshot = initial_snapshot(panel);

        // This is the snapshot the webview posts after sanitizing initial metadata.
        await panel.__receive({
            type: 'stateChanged',
            sourceGeneration: snapshot.sourceGeneration,
            snapshotIdentity: snapshot.identity,
            state: { transforms: [undefined], activeSheetIndex: 0 },
        } as never);

        expect(state.get_state(file_path).transforms).toEqual([undefined]);
    });

    it('durably clears a cancelled restore and ignores a late stale snapshot', async () => {
        const file_path = '/tmp/cancelled-restore.csv';
        const saved_transform = {
            sort: [{ colIndex: 0, direction: 'asc' as const }],
            filters: [],
            schema: '["Sheet1",1,["h"]]',
        };
        const state = state_store({ transforms: [saved_transform] });
        const first = open_csv_table(uri(file_path), state.store);
        await first.__receive({ type: 'ready' });
        const meta = initial_snapshot(first);

        await first.__receive({
            type: 'setTransform',
            sheetIndex: 0,
            requestId: 'restore',
            generation: meta.generation,
            sourceGeneration: meta.sourceGeneration,
            intent: 'restore',
            state: saved_transform,
        } as never);
        expect(state.get_state(file_path).transforms).toEqual([saved_transform]);

        const restore_ack = first.__messages.find((message) =>
            typeof message === 'object'
            && message !== null
            && 'type' in message
            && message.type === 'transformApplied',
        ) as { generation: number };
        await first.__receive({
            type: 'setTransform',
            sheetIndex: 0,
            requestId: 'cancel',
            // Deliberately use the pre-ack view generation: source identity,
            // not cache generation, authorizes this Cancel.
            generation: meta.generation,
            sourceGeneration: meta.sourceGeneration,
            intent: 'cancel',
            state: {
                sort: [],
                filters: [],
                schema: saved_transform.schema,
            },
        } as never);
        expect(restore_ack.generation).toBeGreaterThan(meta.generation);
        expect(state.get_state(file_path).transforms).toEqual([undefined]);

        // A debounced snapshot captured before Cancel must not resurrect it.
        await first.__receive({
            type: 'stateChanged',
            sourceGeneration: meta.sourceGeneration,
            snapshotIdentity: meta.identity,
            state: { transforms: [saved_transform], activeSheetIndex: 0 },
        } as never);
        expect(state.get_state(file_path).transforms).toEqual([undefined]);

        first.dispose();
        const reopened = open_csv_table(uri(file_path), state.store);
        await reopened.__receive({ type: 'ready' });
        const reopened_meta = initial_snapshot(reopened);
        expect(reopened_meta.state.transforms).toEqual([undefined]);
    });

    it('does not acknowledge Cancel until its durable clear completes', async () => {
        const file_path = '/tmp/durable-cancel.csv';
        const gate = deferred();
        let current: PerFileState = {
            transforms: [{
                sort: [{ colIndex: 0, direction: 'asc' }],
                filters: [],
                schema: '["Sheet1",1,["h"]]',
            }],
        };
        let revision = 0;
        const store: FileStateStore = {
            async read() {
                return { state: structuredClone(current), revision };
            },
            async compare_and_set(_path, expected, next) {
                await gate.promise;
                if (expected !== revision) {
                    return {
                        type: 'conflict',
                        snapshot: { state: structuredClone(current), revision },
                    };
                }
                current = structuredClone(next);
                revision += 1;
                return {
                    type: 'committed',
                    snapshot: { state: structuredClone(current), revision },
                };
            },
            async touch() {},
        };
        const panel = open_csv_table(uri(file_path), store);
        await panel.__receive({ type: 'ready' });
        const meta = initial_snapshot(panel);

        const cancel = panel.__receive({
            type: 'setTransform',
            sheetIndex: 0,
            requestId: 'cancel',
            generation: meta.generation,
            sourceGeneration: meta.sourceGeneration,
            intent: 'cancel',
            state: {
                sort: [],
                filters: [],
                schema: '["Sheet1",1,["h"]]',
            },
        } as never);
        await Promise.resolve();
        expect(panel.__messages.some((message) =>
            typeof message === 'object'
            && message !== null
            && 'type' in message
            && message.type === 'transformApplied')).toBe(false);

        gate.resolve();
        await cancel;
        expect(current.transforms).toEqual([undefined]);
        expect(panel.__messages.some((message) =>
            typeof message === 'object'
            && message !== null
            && 'type' in message
            && message.type === 'transformApplied')).toBe(true);
    });

    it('invalidates transform persistence when ready starts around CAS validation', async () => {
        const file_path = '/tmp/ready-transform-cas.csv';
        const versioned = state_store();
        const cas_started = deferred();
        const cas_gate = deferred();
        const store: FileStateStore = {
            ...versioned.store,
            async compare_and_set(path, expected, next, validate) {
                if (next.transforms?.[0]) {
                    cas_started.resolve();
                    await cas_gate.promise;
                }
                return versioned.store.compare_and_set(path, expected, next, validate);
            },
        };
        const panel = open_csv_table(uri(file_path), store);
        await panel.__receive({ type: 'ready' });
        const snapshot = initial_snapshot(panel);
        panel.__messages.length = 0;

        const transform = panel.__receive({
            type: 'setTransform',
            sheetIndex: 0,
            requestId: 'receiver-1:0:1',
            generation: snapshot.generation,
            sourceGeneration: snapshot.sourceGeneration,
            intent: 'user',
            state: {
                sort: [{ colIndex: 0, direction: 'desc' }],
                filters: [],
                schema: '["Sheet1",1,["h"]]',
            },
        });
        await cas_started.promise;
        const ready = panel.__receive({ type: 'ready' });
        cas_gate.resolve();
        await Promise.all([transform, ready]);

        expect(versioned.get_state(file_path).transforms).toBeUndefined();
        expect(panel.__messages.some((message) => (
            typeof message === 'object'
            && message !== null
            && 'type' in message
            && message.type === 'transformApplied'
        ))).toBe(false);
        expect(latest_snapshot(panel).generation).toBe(snapshot.generation);
    });

    it('waits for a committed empty-transform install before completing ready', async () => {
        const file_path = '/tmp/ready-empty-transform-barrier.csv';
        let stored: unknown = {};
        let block_update = false;
        const update_started = deferred();
        const update_gate = deferred();
        const context = {
            globalState: {
                get: (_key: string, fallback: unknown) => stored ?? fallback,
                async update(_key: string, value: unknown) {
                    if (block_update) {
                        block_update = false;
                        update_started.resolve();
                        await update_gate.promise;
                    }
                    stored = structuredClone(value);
                },
            },
        } as unknown as ExtensionContext;
        const store = create_file_state_store(context);
        vscode_mock.__setReadFileImplementation(async () => enc.encode('h\nc\na\nb\n'));
        vscode_mock.__setStatImplementation(async () => ({ size: 8, mtime: 1 }));
        const panel = open_csv_table(uri(file_path), store);
        await panel.__receive({ type: 'ready' });
        const initial = latest_snapshot(panel);

        await panel.__receive({
            type: 'setTransform',
            sheetIndex: 0,
            requestId: 'install-desc',
            generation: initial.generation,
            sourceGeneration: initial.sourceGeneration,
            intent: 'user',
            state: {
                sort: [{ colIndex: 0, direction: 'desc' }],
                filters: [],
                schema: '["Sheet1",1,["h"]]',
            },
        });
        const transformed = latest_snapshot(panel);
        const applied = [...panel.__messages].reverse().find((message) => (
            typeof message === 'object'
            && message !== null
            && 'type' in message
            && message.type === 'transformApplied'
        )) as { generation: number; sourceGeneration: number };

        panel.__messages.length = 0;
        block_update = true;
        const clear = panel.__receive({
            type: 'setTransform',
            sheetIndex: 0,
            requestId: 'clear-transform',
            generation: applied.generation,
            sourceGeneration: applied.sourceGeneration,
            intent: 'user',
            state: {
                sort: [],
                filters: [],
                schema: '["Sheet1",1,["h"]]',
            },
        });
        await update_started.promise;
        const ready = panel.__receive({ type: 'ready' });
        let ready_finished = false;
        void ready.then(() => { ready_finished = true; });
        await flush_promises();
        expect(ready_finished).toBe(false);

        update_gate.resolve();
        await Promise.all([clear, ready]);

        const durable = await store.read(file_path);
        expect((durable.state as PerFileState).transforms).toEqual([undefined]);
        expect(panel.__messages.some((message) => (
            typeof message === 'object'
            && message !== null
            && 'type' in message
            && message.type === 'transformApplied'
            && (message as { requestId?: string }).requestId === 'clear-transform'
        ))).toBe(false);
        const ready_snapshot = latest_snapshot(panel);
        expect(ready_snapshot.generation).toBe(applied.generation + 1);
        expect(ready_snapshot.sourceGeneration).toBe(initial.sourceGeneration);
        expect(transformed.sourceGeneration).toBe(initial.sourceGeneration);

        await panel.__receive({
            type: 'requestRows',
            sheetIndex: 0,
            startRow: 0,
            count: 3,
            requestId: 'natural',
            generation: ready_snapshot.generation,
        });
        expect(panel.__messages).toContainEqual(expect.objectContaining({
            type: 'rowData',
            requestId: 'natural',
            rows: [
                [expect.objectContaining({ raw: 'c' })],
                [expect.objectContaining({ raw: 'a' })],
                [expect.objectContaining({ raw: 'b' })],
            ],
        }));
    });

    it('reconciles a superseded durable transform when newer Cancel persistence fails', async () => {
        const file_path = '/tmp/superseded-transform-cancel-failure.csv';
        let stored: unknown = {};
        let block_ascending = false;
        let reject_descending = false;
        const ascending_update_started = deferred();
        const ascending_update_gate = deferred();
        const context = {
            globalState: {
                get: (_key: string, fallback: unknown) => stored ?? fallback,
                async update(_key: string, value: unknown) {
                    const direction = (value as {
                        entries?: Record<string, {
                            state?: { transforms?: Array<{ sort?: Array<{ direction?: string }> }> };
                        }>;
                    }).entries?.[file_path]?.state?.transforms?.[0]?.sort?.[0]?.direction;
                    if (block_ascending && direction === 'asc') {
                        block_ascending = false;
                        ascending_update_started.resolve();
                        await ascending_update_gate.promise;
                    }
                    if (reject_descending && direction === 'desc') {
                        reject_descending = false;
                        throw new Error('cancel persistence rejected');
                    }
                    stored = structuredClone(value);
                },
            },
        } as unknown as ExtensionContext;
        const store = create_file_state_store(context);
        vscode_mock.__setReadFileImplementation(async () => enc.encode('h\nc\na\nb\n'));
        vscode_mock.__setStatImplementation(async () => ({ size: 8, mtime: 1 }));
        const panel = open_csv_table(uri(file_path), store);
        await panel.__receive({ type: 'ready' });
        const initial = latest_snapshot(panel);
        const schema = '["Sheet1",1,["h"]]';
        const preferred = {
            sort: [{ colIndex: 0, direction: 'desc' as const }],
            filters: [],
            schema,
        };
        await panel.__receive({
            type: 'setTransform',
            sheetIndex: 0,
            requestId: 'install-preferred',
            generation: initial.generation,
            sourceGeneration: initial.sourceGeneration,
            intent: 'user',
            state: preferred,
        });
        const installed = [...panel.__messages].reverse().find((message) => (
            typeof message === 'object'
            && message !== null
            && 'type' in message
            && message.type === 'transformApplied'
            && (message as { requestId?: string }).requestId === 'install-preferred'
        )) as { generation: number; sourceGeneration: number };

        block_ascending = true;
        const a = panel.__receive({
            type: 'setTransform',
            sheetIndex: 0,
            requestId: 'A',
            generation: installed.generation,
            sourceGeneration: installed.sourceGeneration,
            intent: 'user',
            state: {
                sort: [{ colIndex: 0, direction: 'asc' }],
                filters: [],
                schema,
            },
        });
        await ascending_update_started.promise;
        reject_descending = true;
        const cancel_b = panel.__receive({
            type: 'setTransform',
            sheetIndex: 0,
            requestId: 'Cancel-B',
            generation: installed.generation,
            sourceGeneration: installed.sourceGeneration,
            intent: 'cancel',
            state: preferred,
        });
        ascending_update_gate.resolve();
        await Promise.all([a, cancel_b]);

        const durable = await store.read(file_path);
        expect((durable.state as PerFileState).transforms?.[0]?.sort).toEqual([
            { colIndex: 0, direction: 'asc' },
        ]);
        const converged = latest_snapshot(panel);
        expect(converged.state.transforms?.[0]?.sort).toEqual([
            { colIndex: 0, direction: 'asc' },
        ]);
        await panel.__receive({
            type: 'requestRows',
            sheetIndex: 0,
            startRow: 0,
            count: 3,
            requestId: 'converged-rows',
            generation: converged.generation,
        });
        expect(panel.__messages).toContainEqual(expect.objectContaining({
            type: 'rowData',
            requestId: 'converged-rows',
            rows: [
                [expect.objectContaining({ raw: 'a' })],
                [expect.objectContaining({ raw: 'b' })],
                [expect.objectContaining({ raw: 'c' })],
            ],
        }));
    });

    it('reconciles a cross-panel durable transform clear before ready completes', async () => {
        const file_path = '/tmp/cross-panel-transform-clear.csv';
        const shared = state_store();
        vscode_mock.__setReadFileImplementation(async () => enc.encode('h\nc\na\nb\n'));
        vscode_mock.__setStatImplementation(async () => ({ size: 8, mtime: 1 }));
        const retaining = open_csv_table(uri(file_path), shared.store);
        const clearing = open_csv_table(uri(file_path), shared.store);
        await retaining.__receive({ type: 'ready' });
        await clearing.__receive({ type: 'ready' });
        const initial = latest_snapshot(retaining);

        await retaining.__receive({
            type: 'setTransform',
            sheetIndex: 0,
            requestId: 'retain-desc',
            generation: initial.generation,
            sourceGeneration: initial.sourceGeneration,
            intent: 'user',
            state: {
                sort: [{ colIndex: 0, direction: 'desc' }],
                filters: [],
                schema: '["Sheet1",1,["h"]]',
            },
        });
        await clearing.__receive({ type: 'ready' });
        const clearing_snapshot = latest_snapshot(clearing);
        await clearing.__receive({
            type: 'setTransform',
            sheetIndex: 0,
            requestId: 'durable-clear',
            generation: clearing_snapshot.generation,
            sourceGeneration: clearing_snapshot.sourceGeneration,
            intent: 'user',
            state: {
                sort: [],
                filters: [],
                schema: '["Sheet1",1,["h"]]',
            },
        });
        expect(shared.get_state(file_path).transforms).toEqual([undefined]);

        retaining.__messages.length = 0;
        await retaining.__receive({ type: 'ready' });
        const reconciled = latest_snapshot(retaining);
        expect(reconciled.generation).toBe(initial.generation + 2);
        expect(reconciled.sourceGeneration).toBe(initial.sourceGeneration);
        await retaining.__receive({
            type: 'requestRows',
            sheetIndex: 0,
            startRow: 0,
            count: 3,
            requestId: 'natural-after-clear',
            generation: reconciled.generation,
        });
        expect(retaining.__messages).toContainEqual(expect.objectContaining({
            type: 'rowData',
            requestId: 'natural-after-clear',
            rows: [
                [expect.objectContaining({ raw: 'c' })],
                [expect.objectContaining({ raw: 'a' })],
                [expect.objectContaining({ raw: 'b' })],
            ],
        }));
    });

    it('revalidates durable state before installing a ready transform', async () => {
        const file_path = '/tmp/ready-transform-revision-revalidation.csv';
        const saved_transform = {
            sort: [{ colIndex: 0, direction: 'asc' as const }],
            filters: [],
            schema: '["Sheet1",1,["h"]]',
        };
        const versioned = state_store({ transforms: [saved_transform] });
        const stale_confirmation_captured = deferred();
        const stale_confirmation_gate = deferred();
        let ready_read_count = 0;
        let delay_stale_confirmation = false;
        const store: FileStateStore = {
            ...versioned.store,
            async read(path) {
                const snapshot = await versioned.store.read(path);
                if (delay_stale_confirmation) {
                    ready_read_count += 1;
                    if (ready_read_count === 2) {
                        delay_stale_confirmation = false;
                        stale_confirmation_captured.resolve();
                        await stale_confirmation_gate.promise;
                    }
                }
                return snapshot;
            },
        };
        vscode_mock.__setReadFileImplementation(async () => enc.encode('h\nc\na\nb\n'));
        vscode_mock.__setStatImplementation(async () => ({ size: 8, mtime: 1 }));
        const retaining = open_csv_table(uri(file_path), store);
        const clearing = open_csv_table(uri(file_path), store);
        await retaining.__receive({ type: 'ready' });
        await clearing.__receive({ type: 'ready' });
        const clearing_snapshot = latest_snapshot(clearing);

        retaining.__messages.length = 0;
        delay_stale_confirmation = true;
        const ready = retaining.__receive({ type: 'ready' });
        await stale_confirmation_captured.promise;
        await clearing.__receive({
            type: 'setTransform',
            sheetIndex: 0,
            requestId: 'clear-after-stale-confirmation-read',
            generation: clearing_snapshot.generation,
            sourceGeneration: clearing_snapshot.sourceGeneration,
            intent: 'user',
            state: { sort: [], filters: [], schema: saved_transform.schema },
        });
        stale_confirmation_gate.resolve();
        await ready;

        const settled = latest_snapshot(retaining);
        expect(settled.state.transforms).toEqual([undefined]);
        await retaining.__receive({
            type: 'requestRows',
            sheetIndex: 0,
            startRow: 0,
            count: 3,
            requestId: 'stable-natural',
            generation: settled.generation,
        });
        expect(retaining.__messages).toContainEqual(expect.objectContaining({
            type: 'rowData',
            requestId: 'stable-natural',
            rows: [
                [expect.objectContaining({ raw: 'c' })],
                [expect.objectContaining({ raw: 'a' })],
                [expect.objectContaining({ raw: 'b' })],
            ],
        }));
    });

    it('rebases ready after source replacement cancels transform reconciliation', async () => {
        const file_path = '/tmp/ready-transform-source-rebase.csv';
        const saved_transform = {
            sort: [{ colIndex: 0, direction: 'asc' as const }],
            filters: [],
            schema: '["Sheet1",1,["h"]]',
        };
        const versioned = state_store({ transforms: [saved_transform] });
        const ready_read_started = deferred();
        let signal_ready_read = false;
        const store: FileStateStore = {
            ...versioned.store,
            async read(path) {
                const snapshot = await versioned.store.read(path);
                if (signal_ready_read) {
                    signal_ready_read = false;
                    ready_read_started.resolve();
                }
                return snapshot;
            },
        };
        let bytes = enc.encode('h\nc\na\nb\n');
        vscode_mock.__setReadFileImplementation(async () => bytes);
        vscode_mock.__setStatImplementation(async () => ({ size: bytes.byteLength, mtime: 1 }));
        const panel = open_csv_table(uri(file_path), store);
        await panel.__receive({ type: 'ready' });
        const before = latest_snapshot(panel);

        panel.__messages.length = 0;
        signal_ready_read = true;
        const ready = panel.__receive({ type: 'ready' });
        await ready_read_started.promise;
        await new Promise<void>((resolve) => setImmediate(resolve));
        bytes = enc.encode('h\nz\ny\nx\n');
        await vscode_mock.__getActiveWatchers()[0].__fireChange(uri(file_path) as never);
        await ready;

        const rebased = latest_snapshot(panel);
        expect(rebased.sourceGeneration).toBeGreaterThan(before.sourceGeneration);
        await panel.__receive({
            type: 'requestRows',
            sheetIndex: 0,
            startRow: 0,
            count: 3,
            requestId: 'rebased-sorted',
            generation: rebased.generation,
        });
        expect(panel.__messages).toContainEqual(expect.objectContaining({
            type: 'rowData',
            requestId: 'rebased-sorted',
            rows: [
                [expect.objectContaining({ raw: 'x' })],
                [expect.objectContaining({ raw: 'y' })],
                [expect.objectContaining({ raw: 'z' })],
            ],
        }));

        const delivered_generation = rebased.sourceGeneration;
        bytes = enc.encode('h\nq\np\no\n');
        await vscode_mock.__getActiveWatchers()[0].__fireChange(uri(file_path) as never);
        await flush_promises();
        expect(latest_snapshot(panel).sourceGeneration).toBeGreaterThan(delivered_generation);
    });

    it('rebases ready when a sibling commits while transform preparation later throws', async () => {
        const file_path = '/tmp/ready-transform-throw-revision-rebase.csv';
        const invalid_transform = {
            sort: [],
            filters: [{
                id: 'invalid-numeric-filter',
                colIndex: 0,
                operator: 'greaterThan' as const,
                value: 'not-a-number',
                caseSensitive: false,
                enabled: true,
            }],
            schema: '["Sheet1",1,null]',
        };
        const versioned = state_store({ transforms: [invalid_transform] });
        const scan_started = deferred();
        let signal_scan = false;
        const retaining_profile: ViewerProfile = {
            editing: false,
            async build_source() {
                return new SignallingInvalidFilterSource(() => {
                    if (signal_scan) {
                        signal_scan = false;
                        scan_started.resolve();
                    }
                });
            },
        };
        const sibling_profile: ViewerProfile = {
            editing: false,
            async build_source() { return new StubSource(); },
        };
        const retaining = open_csv_table(uri(file_path), versioned.store, retaining_profile);
        const sibling = open_csv_table(uri(file_path), versioned.store, sibling_profile);
        await retaining.__receive({ type: 'ready' });
        await sibling.__receive({ type: 'ready' });
        const sibling_snapshot = latest_snapshot(sibling);
        const error = vi.spyOn(console, 'error').mockImplementation(() => {});

        retaining.__messages.length = 0;
        signal_scan = true;
        const ready = retaining.__receive({ type: 'ready' });
        await scan_started.promise;
        await sibling.__receive({
            type: 'setTransform',
            sheetIndex: 0,
            requestId: 'sibling-clears-invalid-transform',
            generation: sibling_snapshot.generation,
            sourceGeneration: sibling_snapshot.sourceGeneration,
            intent: 'user',
            state: { sort: [], filters: [], schema: invalid_transform.schema },
        });
        await ready;

        expect(versioned.get_state(file_path).transforms).toEqual([undefined]);
        expect(latest_snapshot(retaining).state.transforms).toEqual([undefined]);
        expect(error).toHaveBeenCalledWith(
            expect.stringContaining('Failed to reconcile table transforms'),
            expect.any(Error),
        );
    });

    it('confirms an unchanged revision after reconciliation and confirmation-read errors', async () => {
        const file_path = '/tmp/ready-transform-error-confirmation.csv';
        const saved_transform = {
            sort: [],
            filters: [{
                id: 'invalid-numeric-filter',
                colIndex: 0,
                operator: 'greaterThan' as const,
                value: 'not-a-number',
                caseSensitive: false,
                enabled: true,
            }],
            schema: '["Sheet1",1,null]',
        };
        const versioned = state_store({ transforms: [saved_transform] });
        let reject_confirmation = false;
        const store: FileStateStore = {
            ...versioned.store,
            async read(path) {
                if (reject_confirmation) {
                    reject_confirmation = false;
                    throw new Error('transient confirming read failure');
                }
                return versioned.store.read(path);
            },
        };
        const profile: ViewerProfile = {
            editing: false,
            async build_source() {
                return new SignallingInvalidFilterSource(() => {
                    reject_confirmation = true;
                });
            },
        };
        const error = vi.spyOn(console, 'error').mockImplementation(() => {});
        const panel = open_csv_table(uri(file_path), store, profile);
        await panel.__receive({ type: 'ready' });
        const before = sheet_meta_count(panel);

        await panel.__receive({ type: 'ready' });
        expect(sheet_meta_count(panel)).toBe(before + 1);
        expect(latest_snapshot(panel).state.transforms).toEqual([saved_transform]);
        expect(versioned.revision(file_path)).toBe(0);
        expect(error).toHaveBeenCalledWith(
            expect.stringContaining('Failed to reconcile table transforms'),
            expect.any(Error),
        );
    });

    it('completes the ready gate after transform reconciliation throws', async () => {
        const file_path = '/tmp/ready-transform-error-gate.csv';
        const saved_transform = {
            sort: [{ colIndex: 0, direction: 'asc' as const }],
            filters: [],
            schema: '["Sheet1",1,null]',
        };
        const state = state_store({ transforms: [saved_transform] });
        const profile: ViewerProfile = {
            editing: false,
            async build_source() {
                return new FailingTransformSource();
            },
        };
        const error = vi.spyOn(console, 'error').mockImplementation(() => {});
        const panel = open_csv_table(uri(file_path), state.store, profile);
        await panel.__receive({ type: 'ready' });
        const before = sheet_meta_count(panel);

        await panel.__receive({ type: 'ready' });
        expect(sheet_meta_count(panel)).toBe(before + 1);
        await panel.__receive({ type: 'ready' });
        expect(sheet_meta_count(panel)).toBe(before + 2);
        expect(state.get_state(file_path).transforms).toEqual([saved_transform]);
        expect(error).toHaveBeenCalledWith(
            expect.stringContaining('Failed to reconcile table transforms'),
            expect.any(Error),
        );
    });

    it('keeps host-owned restore preferences after a restore read failure', async () => {
        const file_path = '/tmp/restore-failure.csv';
        const saved_transform = {
            sort: [{ colIndex: 0, direction: 'asc' as const }],
            filters: [],
            schema: '["Sheet1",1,null]',
        };
        const state = state_store({ transforms: [saved_transform] });
        const profile: ViewerProfile = {
            editing: false,
            async build_source() {
                return new FailingTransformSource();
            },
        };
        const panel = open_csv_table(uri(file_path), state.store, profile);
        await panel.__receive({ type: 'ready' });
        const meta = initial_snapshot(panel);

        await panel.__receive({
            type: 'setTransform',
            sheetIndex: 0,
            requestId: 'restore',
            generation: meta.generation,
            sourceGeneration: meta.sourceGeneration,
            intent: 'restore',
            state: saved_transform,
        } as never);

        const ack = panel.__messages.find((message) =>
            typeof message === 'object'
            && message !== null
            && 'type' in message
            && message.type === 'transformApplied',
        ) as { error?: string };
        expect(ack.error).toContain('column read failed');
        expect(state.get_state(file_path).transforms).toEqual([saved_transform]);
    });

    it('rejects transforms while an edit session is owned', async () => {
        const panel = open_csv_table(uri('/tmp/session.csv'), state_store().store);
        await panel.__receive({ type: 'ready' });
        await panel.__receive({ type: 'requestEditSession' } as never);

        await panel.__receive({
            type: 'setTransform',
            sheetIndex: 0,
            requestId: 'during-edit',
            sourceGeneration: 1,
            intent: 'user',
            state: {
                sort: [{ colIndex: 0, direction: 'asc' }],
                filters: [],
                schema: '["Sheet1",1,["h"]]',
            },
        } as never);

        const response = panel.__messages.find((message) =>
            typeof message === 'object'
            && message !== null
            && 'type' in message
            && message.type === 'transformApplied',
        ) as { error?: string } | undefined;
        expect(response?.error).toContain('Exit edit mode');
    });

    it('rejects a sibling transform while another panel owns CSV editing', async () => {
        const file_path = '/tmp/cross-panel-owned-transform.csv';
        const shared = state_store();
        const owner = open_csv_table(uri(file_path), shared.store);
        const sibling = open_csv_table(uri(file_path), shared.store);
        await owner.__receive({ type: 'ready' });
        await sibling.__receive({ type: 'ready' });
        await owner.__receive({ type: 'requestEditSession' } as never);
        const sibling_snapshot = latest_snapshot(sibling);

        await sibling.__receive({
            type: 'setTransform',
            sheetIndex: 0,
            requestId: 'sibling-during-edit',
            generation: sibling_snapshot.generation,
            sourceGeneration: sibling_snapshot.sourceGeneration,
            intent: 'user',
            state: {
                sort: [{ colIndex: 0, direction: 'asc' }],
                filters: [],
                schema: '["Sheet1",1,["h"]]',
            },
        });

        expect(shared.get_state(file_path).transforms).toBeUndefined();
        expect(sibling.__messages).toContainEqual(expect.objectContaining({
            type: 'transformApplied',
            requestId: 'sibling-during-edit',
            error: expect.stringContaining('edit mode'),
        }));
    });

    it('reserves an edit claim before state I/O so a sibling transform cannot overtake it', async () => {
        const file_path = '/tmp/edit-claim-transform-race.csv';
        const versioned = state_store();
        const read_started = deferred();
        const read_gate = deferred();
        let block_read = false;
        const store: FileStateStore = {
            ...versioned.store,
            async read(path) {
                if (block_read) {
                    block_read = false;
                    read_started.resolve();
                    await read_gate.promise;
                }
                return versioned.store.read(path);
            },
        };
        const claimant = open_csv_table(uri(file_path), store);
        const sibling = open_csv_table(uri(file_path), store);
        await claimant.__receive({ type: 'ready' });
        await sibling.__receive({ type: 'ready' });
        const sibling_snapshot = latest_snapshot(sibling);

        block_read = true;
        const claim = claimant.__receive({ type: 'requestEditSession' } as never);
        await read_started.promise;
        await sibling.__receive({
            type: 'setTransform',
            sheetIndex: 0,
            requestId: 'overtaking-transform',
            generation: sibling_snapshot.generation,
            sourceGeneration: sibling_snapshot.sourceGeneration,
            intent: 'user',
            state: {
                sort: [{ colIndex: 0, direction: 'asc' }],
                filters: [],
                schema: '["Sheet1",1,["h"]]',
            },
        });
        read_gate.resolve();
        await claim;

        expect(edit_session_results(claimant).at(-1)).toEqual({
            type: 'editSessionResult', granted: true,
        });
        expect(versioned.get_state(file_path).transforms).toBeUndefined();
        expect(sibling.__messages).toContainEqual(expect.objectContaining({
            type: 'transformApplied',
            requestId: 'overtaking-transform',
            error: expect.stringContaining('edit mode'),
        }));
    });

    it('does not grant a sibling edit claim while transform work is admitted or installed', async () => {
        const file_path = '/tmp/cross-panel-transform-edit-race.csv';
        const shared = state_store();
        const transformer = open_csv_table(uri(file_path), shared.store);
        const claimant = open_csv_table(uri(file_path), shared.store);
        await transformer.__receive({ type: 'ready' });
        await claimant.__receive({ type: 'ready' });
        const snapshot = latest_snapshot(transformer);

        const transform = transformer.__receive({
            type: 'setTransform',
            sheetIndex: 0,
            requestId: 'admitted-transform',
            generation: snapshot.generation,
            sourceGeneration: snapshot.sourceGeneration,
            intent: 'user',
            state: {
                sort: [{ colIndex: 0, direction: 'asc' }],
                filters: [],
                schema: '["Sheet1",1,["h"]]',
            },
        });
        await claimant.__receive({ type: 'requestEditSession' } as never);
        await transform;
        await claimant.__receive({ type: 'requestEditSession' } as never);

        expect(edit_session_results(claimant)).toEqual([
            { type: 'editSessionResult', granted: false },
            { type: 'editSessionResult', granted: false },
        ]);
    });

    it('keeps ready natural during an owned edit session and saves the same physical row', async () => {
        const file_path = '/tmp/edit-transform-row-identity.csv';
        const shared = state_store();
        let bytes = enc.encode('h\nc\na\nb\n');
        vscode_mock.__setStatImplementation(async () => ({ size: bytes.byteLength, mtime: 1 }));
        vscode_mock.__setReadFileImplementation(async () => bytes);
        vscode_mock.__setWriteFileImplementation(async (_uri, content) => {
            bytes = new Uint8Array(content);
        });
        const owner = open_csv_table(uri(file_path), shared.store);
        const sibling = open_csv_table(uri(file_path), shared.store);
        await owner.__receive({ type: 'ready' });
        await sibling.__receive({ type: 'ready' });
        await owner.__receive({ type: 'requestEditSession' } as never);
        const edit_session_id = latest_edit_session_message(owner)!.editSessionId!;
        const sibling_snapshot = latest_snapshot(sibling);

        await sibling.__receive({
            type: 'setTransform',
            sheetIndex: 0,
            requestId: 'sort-while-owned',
            generation: sibling_snapshot.generation,
            sourceGeneration: sibling_snapshot.sourceGeneration,
            intent: 'user',
            state: {
                sort: [{ colIndex: 0, direction: 'asc' }],
                filters: [],
                schema: '["Sheet1",1,["h"]]',
            },
        });
        owner.__messages.length = 0;
        await owner.__receive({ type: 'ready' });
        const remounted = latest_snapshot(owner);
        await owner.__receive({
            type: 'requestRows', sheetIndex: 0, startRow: 0, count: 3,
            requestId: 'natural-owned-rows', generation: remounted.generation,
        });
        expect(owner.__messages).toContainEqual(expect.objectContaining({
            type: 'rowData',
            requestId: 'natural-owned-rows',
            rows: [
                [expect.objectContaining({ raw: 'c' })],
                [expect.objectContaining({ raw: 'a' })],
                [expect.objectContaining({ raw: 'b' })],
            ],
        }));

        await owner.__receive({
            type: 'saveCsv',
            operation: {
                editSessionId: edit_session_id,
                saveRequestId: 'save-natural-row',
                edits: { '0:0': 'edited-c' },
                dirtyEdits: { '0:0': { value: 'edited-c', base: 'c' } },
            },
        });
        await flush_promises();
        expect(new TextDecoder().decode(bytes)).toBe('h\nedited-c\na\nb\n');
    });

    it('does not grant edit mode while a transform is computing', async () => {
        const panel = open_csv_table(uri('/tmp/session.csv'), state_store().store);
        await panel.__receive({ type: 'ready' });

        const transform = panel.__receive({
            type: 'setTransform',
            sheetIndex: 0,
            requestId: 'pending',
            sourceGeneration: 1,
            intent: 'user',
            state: {
                sort: [{ colIndex: 0, direction: 'asc' }],
                filters: [],
                schema: '["Sheet1",1,["h"]]',
            },
        } as never);
        await panel.__receive({ type: 'requestEditSession' } as never);
        await transform;

        expect(edit_session_results(panel)).toEqual([
            { type: 'editSessionResult', granted: false },
        ]);
    });

    it('projects pending edits for the owner but not a pre-ready watcher adoption in a nonowner', async () => {
        const file_path = '/tmp/pre-ready-nonowner.csv';
        const pendingEdits = { '0:0': { value: 'owner', base: 'a' } };
        const state = state_store({ pendingEdits });
        const first = open_csv_table(uri(file_path), state.store);
        await first.__receive({ type: 'ready' });
        expect(latest_snapshot(first).state.pendingEdits).toEqual(pendingEdits);

        const second = open_csv_table(uri(file_path), state.store);
        expect(vscode_mock.__getActiveWatchers()).toHaveLength(1);
        const shared_watcher = vscode_mock.__getActiveWatchers()[0];
        await shared_watcher.__fireChange();
        expect(second.__messages).toHaveLength(0);
        await second.__receive({ type: 'ready' });
        expect(latest_snapshot(second).state.pendingEdits).toBeUndefined();
    });

    it('allows multiple viewers for one CSV file but grants edit mode to only one', async () => {
        const file_uri = uri('/tmp/session.csv');
        const state = state_store();
        const first = open_csv_table(file_uri, state.store);
        const second = open_csv_table(file_uri, state.store);

        await first.__receive({ type: 'ready' });
        await second.__receive({ type: 'ready' });

        expect(sheet_meta_count(first)).toBe(1);
        expect(sheet_meta_count(second)).toBe(1);

        await first.__receive({ type: 'requestEditSession' } as never);
        await second.__receive({ type: 'requestEditSession' } as never);

        expect(edit_session_results(first)).toEqual([
            { type: 'editSessionResult', granted: true },
        ]);
        expect(edit_session_results(second)).toEqual([
            { type: 'editSessionResult', granted: false },
        ]);
    });

    it('rolls back coordinator, edit attachment, and lease when watcher setup fails', async () => {
        const registry_before = file_coordinator_registry_size();
        const versioned = state_store();
        const release = vi.fn(async () => {});
        const store: FileStateStore = {
            ...versioned.store,
            async lease_entry() { return { release }; },
        };
        vscode_mock.__setWatcherRegistrationFailure('create');
        expect(() => open_csv_table(uri('/tmp/setup-failure.csv'), store))
            .toThrow('watch create registration failed');
        vscode_mock.__setWatcherRegistrationFailure(undefined);
        await vi.waitFor(() => expect(release).toHaveBeenCalledOnce());
        expect(file_coordinator_registry_size()).toBe(registry_before);

        const panel = open_csv_table(uri('/tmp/setup-failure.csv'), store);
        await panel.__receive({ type: 'ready' });
        await panel.__receive({ type: 'requestEditSession' } as never);
        expect(edit_session_results(panel).at(-1)).toEqual({
            type: 'editSessionResult', granted: true,
        });
        panel.dispose();
        await vi.waitFor(() => expect(file_coordinator_registry_size()).toBe(registry_before));
    });

    it('isolates edit ownership for provider resources sharing one fsPath', async () => {
        const state = state_store();
        const first_uri = vscode_mock.Uri.from({
            scheme: 'memfs', authority: 'workspace-a', path: '/session.csv',
            query: '', fragment: '', fsPath: '/same/session.csv',
        }) as unknown as vscode.Uri;
        const second_uri = vscode_mock.Uri.from({
            scheme: 'memfs', authority: 'workspace-b', path: '/session.csv',
            query: '', fragment: '', fsPath: '/same/session.csv',
        }) as unknown as vscode.Uri;
        const first = open_csv_table(first_uri, state.store);
        const second = open_csv_table(second_uri, state.store);
        await first.__receive({ type: 'ready' });
        await second.__receive({ type: 'ready' });

        await first.__receive({ type: 'requestEditSession' } as never);
        await second.__receive({ type: 'requestEditSession' } as never);
        expect(edit_session_results(first).at(-1)).toEqual({
            type: 'editSessionResult', granted: true,
        });
        expect(edit_session_results(second).at(-1)).toEqual({
            type: 'editSessionResult', granted: true,
        });
        expect(latest_snapshot(first).identity.authority.fileId)
            .not.toBe(latest_snapshot(second).identity.authority.fileId);
        first.dispose();
        second.dispose();
    });

    it('ignores pending-edit writes from a viewer that does not own the edit session', async () => {
        const file_path = '/tmp/session.csv';
        const file_uri = uri(file_path);
        const state = state_store();
        const first = open_csv_table(file_uri, state.store);
        const second = open_csv_table(file_uri, state.store);

        await first.__receive({ type: 'ready' });
        await second.__receive({ type: 'ready' });
        await first.__receive({ type: 'requestEditSession' } as never);
        await second.__receive({ type: 'requestEditSession' } as never);

        await first.__receive({
            type: 'pendingEditsChanged',
            edits: { '0:0': { value: 'owner', base: 'a' } },
        });
        await second.__receive({
            type: 'pendingEditsChanged',
            edits: { '0:0': { value: 'non-owner', base: 'a' } },
        });

        expect(state.get_state(file_path).pendingEdits).toEqual({
            '0:0': { value: 'owner', base: 'a' },
        });
    });

    it('passes existing pending edits to an already-open viewer that later gets edit mode', async () => {
        const file_path = '/tmp/session.csv';
        const file_uri = uri(file_path);
        const pendingEdits = { '0:0': { value: 'owner', base: 'a' } };
        const state = state_store({ pendingEdits });
        const first = open_csv_table(file_uri, state.store);
        const second = open_csv_table(file_uri, state.store);

        await first.__receive({ type: 'ready' });
        await second.__receive({ type: 'ready' });
        first.dispose();
        await flush_promises();

        await second.__receive({ type: 'requestEditSession' } as never);

        expect(edit_session_results(second)).toContainEqual({
            type: 'editSessionResult',
            granted: true,
            pendingEdits,
        });
    });

    it('clears pending edits and releases ownership atomically on discard', async () => {
        const file_path = '/tmp/session.csv';
        const file_uri = uri(file_path);
        const state = state_store();
        const first = open_csv_table(file_uri, state.store);
        const second = open_csv_table(file_uri, state.store);

        await first.__receive({ type: 'ready' });
        await second.__receive({ type: 'ready' });
        await first.__receive({ type: 'requestEditSession' });
        await first.__receive({
            type: 'pendingEditsChanged',
            edits: { '0:0': { value: 'owner', base: 'a' } },
        });

        await first.__receive({ type: 'discardEditSession' } as never);
        await second.__receive({ type: 'requestEditSession' });

        expect(state.get_state(file_path).pendingEdits).toBeUndefined();
        expect(edit_session_results(second)).toContainEqual({
            type: 'editSessionResult',
            granted: true,
        });
    });

    it('strips pending edits from previews and cannot resurrect a cleared map', async () => {
        const file_path = '/tmp/preview-pending.csv';
        const pending = { '0:0': { value: 'draft', base: 'a' } };
        const state = state_store({ pendingEdits: pending });
        const profile: ViewerProfile = {
            editing: false,
            previewMode: true,
            build_source: async () => new StubSource(),
        };
        const panel = open_csv_table(uri(file_path), state.store, profile);
        await panel.__receive({ type: 'ready' });
        const first = latest_snapshot(panel);
        expect(first.state.pendingEdits).toBeUndefined();

        await state.store.compare_and_set(file_path, state.revision(file_path), {});
        await panel.__receive({
            type: 'stateChanged',
            sourceGeneration: first.sourceGeneration,
            snapshotIdentity: first.identity,
            state: { ...first.state, pendingEdits: pending, columnWidths: [{ 0: 133 }] },
        });
        expect(state.get_state(file_path).pendingEdits).toBeUndefined();
        await panel.__receive({ type: 'ready' });
        const replay = latest_snapshot(panel);
        expect(replay.state.pendingEdits).toBeUndefined();
        expect(replay.state.columnWidths).toEqual([{ 0: 133 }]);
    });

    it('fences preview-originated source messages until the current adoption is ACKed', async () => {
        const on_message = vi.fn(async () => true);
        const profile: ViewerProfile = {
            editing: false,
            previewMode: true,
            build_source: async () => new StubSource(),
            on_message,
        };
        const panel = open_csv_table(
            uri('/tmp/preview-ack-fence.csv'),
            state_store().store,
            profile,
        );
        panel.__autoAckSnapshots = false;
        await panel.__receive({ type: 'ready' });
        const snapshot = initial_snapshot(panel);

        await panel.__receive({ type: 'visibleRowChanged', row: 0 });
        expect(on_message).not.toHaveBeenCalled();
        await panel.__receive({
            type: 'snapshotApplied',
            identity: snapshot.identity,
            disposition: 'applied',
        });
        await panel.__receive({ type: 'visibleRowChanged', row: 0 });
        expect(on_message).toHaveBeenCalledOnce();
    });

    it('surfaces immutable source warnings only after current ACK and deduplicates across panels', async () => {
        const warning_spy = vi.spyOn(vscode_mock.window, 'showWarningMessage');
        class WarningSource extends StubSource {
            readonly warnings = ['CSV warning'];
        }
        const profile: ViewerProfile = {
            editing: false,
            build_source: async () => new WarningSource(),
        };
        const state = state_store();
        const file_uri = uri('/tmp/warnings.csv');
        const first = open_csv_table(file_uri, state.store, profile);
        first.__autoAckSnapshots = false;
        await first.__receive({ type: 'ready' });
        expect(warning_spy).not.toHaveBeenCalled();
        const first_snapshot = initial_snapshot(first);
        await first.__receive({
            type: 'snapshotApplied',
            identity: first_snapshot.identity,
            disposition: 'applied',
        });
        expect(warning_spy).toHaveBeenCalledTimes(1);

        const second = open_csv_table(file_uri, state.store, profile);
        second.__autoAckSnapshots = false;
        await second.__receive({ type: 'ready' });
        const second_snapshot = initial_snapshot(second);
        await second.__receive({
            type: 'snapshotApplied',
            identity: second_snapshot.identity,
            disposition: 'duplicate',
        });
        expect(warning_spy).toHaveBeenCalledTimes(1);
    });

    it('does not warn about another editor when edit mode is denied by truncation', async () => {
        const warning_spy = vi.spyOn(vscode_mock.window, 'showWarningMessage');
        const state = state_store();
        const panel = open_csv_table(uri('/tmp/truncated.csv'), state.store, {
            editing: true,
            build_source: async () => new StubSource('Showing 1 of 2 rows'),
        });

        await panel.__receive({ type: 'ready' });
        await panel.__receive({ type: 'requestEditSession' });

        expect(edit_session_results(panel)).toEqual([
            { type: 'editSessionResult', granted: false },
        ]);
        expect(warning_spy).not.toHaveBeenCalledWith(
            'This file is already being edited in another Table Viewer tab.'
        );
    });
});
