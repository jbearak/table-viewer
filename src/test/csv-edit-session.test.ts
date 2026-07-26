import { createHash } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as vscode from 'vscode';
import type { ExtensionContext } from 'vscode';
import { attach_viewer, csv_table_profile, type ViewerProfile } from '../viewer-controller';
import {
    create_authority_store,
    create_file_state_store,
    type FileStateSnapshot,
    type FileStateStore,
} from '../state';
import type { HostMessage, PerFileState } from '../types';
import type { DataSource, RowWindow, WorkbookMeta } from '../data-source/interface';
import { versioned_state_store } from './helpers/versioned-state-store';
import * as vscode_mock from './mocks/vscode';
import { fake_viewer_host } from './mocks/host-ports';
import { file_coordinator_registry_size } from '../file-coordinator';
import { with_in_memory_authority_transactions } from '../state-authority';
import type { WorkbookSnapshot, WorkbookSnapshotIdentity } from '../viewer-snapshot';
import { InvalidPersistedTransformError } from '../panel-core';

const enc = new TextEncoder();

function source_digest(bytes: Uint8Array): string {
    return createHash('sha256').update(bytes).digest('hex');
}

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
                sourceRowCount: 1,
                columnCount: 1,
                merges: [],
                hasFormatting: false,
            }],
        };
    }
    read_rows(_sheet: number, _start: number, _count: number): RowWindow {
        return { startRow: 0, rows: [[{ raw: 'a', formatted: 'a', bold: false, italic: false }]] };
    }
    close(): void {}
}

class FailingTransformSource extends StubSource {
    override meta(): WorkbookMeta {
        const meta = super.meta();
        return {
            ...meta,
            sheets: [{ ...meta.sheets[0], rowCount: 2, sourceRowCount: 2 }],
        };
    }

    override read_rows(): RowWindow {
        throw new Error('column read failed');
    }
}

class TrackingTransformSource extends StubSource {
    reads = 0;

    override meta(): WorkbookMeta {
        return {
            hasFormatting: false,
            sheets: [{
                name: 'Sheet1',
                rowCount: 3,
                sourceRowCount: 3,
                columnCount: 1,
                merges: [],
                hasFormatting: false,
            }],
        };
    }

    override read_rows(_sheet: number, start: number, count: number): RowWindow {
        this.reads += 1;
        const values = ['c', 'a', 'b'];
        return {
            startRow: start,
            rows: values.slice(start, start + count).map((raw) => [{
                raw,
                formatted: raw,
                bold: false,
                italic: false,
            }]),
        };
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
                    sourceRowCount: 1,
                    columnCount: 2,
                    merges: [],
                    hasFormatting: false,
                },
                {
                    name: 'Sheet2',
                    rowCount: 1,
                    sourceRowCount: 1,
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
        fake_viewer_host,
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

type TransformAnswer =
    | Extract<HostMessage, { type: 'transformInstalled' }>
    | Extract<HostMessage, { type: 'transformRefused' }>;

/** Every answer to a setTransform, whichever arm it arrived on. */
function transform_answers(panel: { __messages: unknown[] }): TransformAnswer[] {
    return panel.__messages.filter((message): message is TransformAnswer => (
        typeof message === 'object'
        && message !== null
        && 'type' in message
        && (message.type === 'transformInstalled'
            || message.type === 'transformRefused')
    ));
}

/** Only the installs: the answers that describe a view and can be quoted back. */
function transform_installs(
    panel: { __messages: unknown[] },
): Array<Extract<HostMessage, { type: 'transformInstalled' }>> {
    return transform_answers(panel).filter((message) => (
        message.type === 'transformInstalled'
    )) as Array<Extract<HostMessage, { type: 'transformInstalled' }>>;
}

/** The basis a following request should quote, read off an install. */
function basis_of(
    installed: Extract<HostMessage, { type: 'transformInstalled' }>,
): { generation: number; sourceGeneration: number } {
    return {
        generation: installed.view.basis.generation,
        sourceGeneration: installed.view.basis.sourceGeneration,
    };
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
        // Spelled out rather than using the mock's legacy `edits` shorthand, which
        // synthesizes `base: 'a'`: the first save already rewrote 0:0 to 'first',
        // so 'a' is no longer this cell's base and host-side base validation would
        // (correctly) refuse the save. 'first' is what the file actually holds.
        await panel.__receive({
            type: 'saveCsv',
            operation: {
                editSessionId: second.editSessionId!,
                saveRequestId: 'second-session-save',
                edits: { '0:0': 'second' },
                dirtyEdits: { '0:0': { value: 'second', base: 'first' } },
            },
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

    it('refuses a save whose base never matched the file, before writing any bytes', async () => {
        const file_path = '/tmp/base-mismatch-rejected.csv';
        const versioned = state_store();
        const write = vi.fn(async () => {});
        const warning = vi.spyOn(vscode_mock.window, 'showWarningMessage');
        // Row 0 column 0 holds 'a'. The save below claims a base of 'stale', which
        // the file never had — the case the webview's residency-gated conflict
        // detection cannot see for a filtered-out or evicted row.
        vscode_mock.__setReadFileImplementation(async () => enc.encode('h\na\nb\n'));
        vscode_mock.__setWriteFileImplementation(write);
        const panel = open_csv_table(uri(file_path), versioned.store);
        await panel.__receive({ type: 'ready' });
        await panel.__receive({ type: 'requestEditSession', requestId: 'edit' });
        const edit_session_id = latest_edit_session_message(panel)!.editSessionId!;

        const operation = {
            editSessionId: edit_session_id,
            saveRequestId: 'save-mismatch',
            edits: { '0:0': 'next', '1:0': 'fine' },
            dirtyEdits: {
                '0:0': { value: 'next', base: 'stale' },
                '1:0': { value: 'fine', base: 'b' },
            },
        };
        await panel.__receive({ type: 'saveCsv', operation });

        expect(write).not.toHaveBeenCalled();
        expect(warning).toHaveBeenCalled();
        expect(panel.__messages).toContainEqual({
            type: 'saveResult',
            success: false,
            lifecycle: expect.objectContaining({ state: 'failed', operation }),
            // Only the drifted key: the honest edit stays saveable once the user
            // resolves this one.
            rejection: { reason: 'baseMismatch', keys: ['0:0'] },
        });
    });

    it('refuses a save for a row the file no longer has, and writes nothing', async () => {
        const file_path = '/tmp/rows-removed-rejected.csv';
        const versioned = state_store();
        const written: Uint8Array[] = [];
        const write = vi.fn(async (_target: unknown, bytes: Uint8Array) => {
            written.push(bytes);
        });
        // One header plus one data row, so source row 3 is past the end. Before
        // host-side validation this save would have silently *grown* the file with
        // blank filler rows to reach row 3.
        vscode_mock.__setReadFileImplementation(async () => enc.encode('h\na\n'));
        vscode_mock.__setWriteFileImplementation(write as never);
        const panel = open_csv_table(uri(file_path), versioned.store);
        await panel.__receive({ type: 'ready' });
        await panel.__receive({ type: 'requestEditSession', requestId: 'edit' });
        const edit_session_id = latest_edit_session_message(panel)!.editSessionId!;

        const operation = {
            editSessionId: edit_session_id,
            saveRequestId: 'save-removed',
            edits: { '3:0': 'orphan' },
            dirtyEdits: { '3:0': { value: 'orphan', base: 'gone' } },
        };
        await panel.__receive({ type: 'saveCsv', operation });

        expect(written).toHaveLength(0);
        expect(panel.__messages).toContainEqual(expect.objectContaining({
            type: 'saveResult',
            success: false,
            rejection: { reason: 'rowsRemoved', keys: ['3:0'] },
        }));
    });

    it('still writes a save whose every base matches, with no rejection', async () => {
        const file_path = '/tmp/valid-bases-still-save.csv';
        const versioned = state_store();
        const written: Uint8Array[] = [];
        const write = vi.fn(async (_target: unknown, bytes: Uint8Array) => {
            written.push(bytes);
        });
        vscode_mock.__setReadFileImplementation(async () => enc.encode('h\na\nb\n'));
        vscode_mock.__setWriteFileImplementation(write as never);
        const panel = open_csv_table(uri(file_path), versioned.store);
        await panel.__receive({ type: 'ready' });
        await panel.__receive({ type: 'requestEditSession', requestId: 'edit' });
        const edit_session_id = latest_edit_session_message(panel)!.editSessionId!;

        await panel.__receive({
            type: 'saveCsv',
            operation: {
                editSessionId: edit_session_id,
                saveRequestId: 'save-valid',
                edits: { '1:0': 'B' },
                dirtyEdits: { '1:0': { value: 'B', base: 'b' } },
            },
        });

        expect(written).toHaveLength(1);
        expect(new TextDecoder().decode(written[0])).toBe('h\na\nB\n');
        const results = panel.__messages.filter((message): message is {
            type: string;
            success: boolean;
            rejection?: unknown;
        } => (
            typeof message === 'object'
            && message !== null
            && 'type' in message
            && message.type === 'saveResult'
        ));
        expect(results).toHaveLength(1);
        expect(results[0].success).toBe(true);
        expect(results[0].rejection).toBeUndefined();
    });

    it('rebases and retains highlights across an extension-controlled CSV save', async () => {
        const file_path = '/tmp/save-highlight-rebase.csv';
        let bytes: Uint8Array<ArrayBufferLike> = enc.encode('h\na\n');
        let mtime = 1;
        let write_finished = false;
        let conflict_injected = false;
        const post_conflict_read_started = deferred();
        const post_conflict_read_gate = deferred();
        const state = state_store({
            rowHeights: [{ 0: 29 }],
            cellHighlights: {
                sourceDigest: source_digest(bytes),
                sheets: [{
                    schema: '["Sheet1",1,["h"]]',
                    cells: { '0:0': 'pink' },
                }],
            },
        });
        let gated_post_conflict_read = false;
        const store: FileStateStore = {
            ...state.store,
            async read(path) {
                if (conflict_injected && !gated_post_conflict_read) {
                    gated_post_conflict_read = true;
                    post_conflict_read_started.resolve();
                    await post_conflict_read_gate.promise;
                }
                return state.store.read(path);
            },
            async compare_and_set(path, expected, next, validate) {
                if (write_finished && !conflict_injected) {
                    const concurrent: PerFileState = {
                        ...next,
                        rowHeights: [{ 0: 41 }],
                        cellHighlights: next.cellHighlights && {
                            ...next.cellHighlights,
                            sheets: [{
                                schema: next.cellHighlights.sheets[0]?.schema ?? 'stale',
                                cells: { '9:0': 'blue' },
                            }],
                        },
                    };
                    const committed = await state.store.compare_and_set(
                        path,
                        expected,
                        concurrent,
                        validate,
                    );
                    if (committed.type !== 'committed') return committed;
                    conflict_injected = true;
                }
                return state.store.compare_and_set(path, expected, next, validate);
            },
        };
        vscode_mock.__setStatImplementation(async () => ({ size: bytes.byteLength, mtime }));
        vscode_mock.__setReadFileImplementation(async () => bytes);
        vscode_mock.__setWriteFileImplementation(async (_uri, next) => {
            bytes = next;
            mtime += 1;
            write_finished = true;
        });
        const panel = open_csv_table(uri(file_path), store);
        await panel.__receive({ type: 'ready' });
        const snapshot = latest_snapshot(panel);
        await panel.__receive({
            type: 'snapshotApplied', identity: snapshot.identity, disposition: 'applied',
        });
        await panel.__receive({ type: 'requestEditSession', requestId: 'edit' });
        const edit_session_id = latest_edit_session_message(panel)!.editSessionId!;
        const save = panel.__receive({
            type: 'saveCsv',
            operation: {
                editSessionId: edit_session_id,
                saveRequestId: 'save-highlight',
                edits: { '0:0': 'saved' },
                dirtyEdits: { '0:0': { value: 'saved', base: 'a' } },
            },
        });
        await post_conflict_read_started.promise;
        expect(panel.__messages).not.toContainEqual(expect.objectContaining({
            type: 'saveResult', success: true,
        }));
        post_conflict_read_gate.resolve();
        await save;
        await flush_promises();

        expect(panel.__messages).toContainEqual(expect.objectContaining({
            type: 'saveResult', success: true,
        }));
        expect(state.get_state(file_path)).toMatchObject({
            rowHeights: [{ 0: 41 }],
            cellHighlights: {
                sourceDigest: source_digest(bytes),
                sheets: [{ cells: { '9:0': 'blue' } }],
            },
        });
    });

    it('keeps an accepted overlay save across ready and restores exact bases on write failure', async () => {
        const file_path = '/tmp/accepted-overlay-remount.csv';
        const versioned = state_store();
        const acceptance_started = deferred();
        const acceptance_gate = deferred();
        const stat = vi.fn(async () => ({ size: 4, mtime: 1 }));
        // Two columns so both edited cells have a distinct, *true* base: host-side
        // base validation now rejects a save whose bases never matched the file, so
        // placeholder base text would fail before reaching the write this test is
        // about.
        const read = vi.fn(async () => enc.encode('h1,h2\na,b\n'));
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
                '0:0': { value: 'overlay', base: 'a' },
                '0:1': { value: 'committed', base: 'b' },
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
            // 'a' is what the default fixture file holds at 0:0. Host-side base
            // validation now rejects a save whose base never matched the file, so a
            // placeholder base would never reach the acceptance retry under test.
            dirtyEdits: { '0:0': { value: 'exact', base: 'a' } },
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

    // The webview echoes the failed operation's own map back after a failed save
    // (`request_save` folds an open live editor in, so the map that went into the
    // operation was never posted and no webview-side dedupe can spot the echo).
    // Read as "the user moved on", that post would retire the failed lifecycle and
    // drop the tombstone, so `release_edit_session` writes no tombstone,
    // `ensure_failed_save_cleanup` never runs, and the edits persisted before the
    // failed disk write survive into the next session.
    it('does not carry an echoed failed save into the next edit session', async () => {
        const file_path = '/tmp/failed-save-echoed-map.csv';
        const versioned = state_store();
        vscode_mock.__setWriteFileImplementation(async () => {
            throw new Error('write failed');
        });
        const panel = open_csv_table(uri(file_path), versioned.store);
        await panel.__receive({ type: 'ready' });
        await panel.__receive({ type: 'requestEditSession', requestId: 'session-a' });
        const session_a = latest_edit_session_message(panel)!.editSessionId!;
        // `'a'` is the file's real value at 0:0 (beforeEach seeds 'h\na\n'), so the
        // host's base validation accepts the save.
        const failed_map = { '0:0': { value: 'A', base: 'a' } };
        await panel.__receive({
            type: 'pendingEditsChanged',
            editSessionId: session_a,
            edits: failed_map,
        });
        await flush_promises();
        await panel.__receive({
            type: 'saveCsv',
            operation: {
                editSessionId: session_a,
                saveRequestId: 'failed-a',
                edits: { '0:0': 'A' },
                dirtyEdits: failed_map,
            },
        });
        await flush_promises();

        // The echo: byte-identical to the failed operation's dirtyEdits.
        await panel.__receive({
            type: 'pendingEditsChanged',
            editSessionId: session_a,
            edits: { '0:0': { value: 'A', base: 'a' } },
        });
        await flush_promises();

        await panel.__receive({ type: 'releaseEditSession', editSessionId: session_a });
        await flush_promises();
        await panel.__receive({ type: 'requestEditSession', requestId: 'session-b' });
        const grant_b = latest_edit_session_message(panel)!;
        expect(grant_b.granted).toBe(true);
        expect(grant_b.editSessionId).not.toBe(session_a);
        expect(grant_b.pendingEdits).toBeUndefined();
        expect(versioned.get_state(file_path).pendingEdits).toBeUndefined();
    });

    it('carries a genuinely newer edit past a failed save into the next session', async () => {
        const file_path = '/tmp/failed-save-superseded-map.csv';
        const versioned = state_store();
        vscode_mock.__setWriteFileImplementation(async () => {
            throw new Error('write failed');
        });
        const panel = open_csv_table(uri(file_path), versioned.store);
        await panel.__receive({ type: 'ready' });
        await panel.__receive({ type: 'requestEditSession', requestId: 'session-a' });
        const session_a = latest_edit_session_message(panel)!.editSessionId!;
        const failed_map = { '0:0': { value: 'A', base: 'a' } };
        await panel.__receive({
            type: 'pendingEditsChanged',
            editSessionId: session_a,
            edits: failed_map,
        });
        await flush_promises();
        await panel.__receive({
            type: 'saveCsv',
            operation: {
                editSessionId: session_a,
                saveRequestId: 'failed-a',
                edits: { '0:0': 'A' },
                dirtyEdits: failed_map,
            },
        });
        await flush_promises();

        const failed = [...panel.__messages].reverse().find((message) => (
            typeof message === 'object'
            && message !== null
            && 'type' in message
            && message.type === 'saveResult'
        )) as { lifecycle: { revision: number; state: string } };
        expect(failed.lifecycle.state).toBe('failed');

        // Not an echo: the user typed again after the failure, so this map must
        // retire the failed lifecycle and survive the release. Guards the
        // value-aware guard against over-tightening into a session-match-only test,
        // which would leave the lifecycle stuck at `failed`.
        const newer = { '0:0': { value: 'A2', base: 'a' } };
        await panel.__receive({
            type: 'pendingEditsChanged',
            editSessionId: session_a,
            edits: newer,
        });
        await flush_promises();
        panel.__messages.length = 0;
        await panel.__receive({ type: 'ready' });
        const retired = latest_snapshot(panel) as ReturnType<typeof latest_snapshot> & {
            capabilities: { csvSaveLifecycle: { revision: number; state: string } };
        };
        expect(retired.capabilities.csvSaveLifecycle).toEqual({
            revision: failed.lifecycle.revision + 1,
            state: 'idle',
        });

        await panel.__receive({ type: 'releaseEditSession', editSessionId: session_a });
        await flush_promises();
        await panel.__receive({ type: 'requestEditSession', requestId: 'session-b' });
        const grant_b = latest_edit_session_message(panel)!;
        expect(grant_b.granted).toBe(true);
        expect(grant_b.pendingEdits).toEqual(newer);
        expect(versioned.get_state(file_path).pendingEdits).toEqual(newer);
    });

    // The tombstone gate records which saves actually made their edits durable, and
    // it has to record that *before* the CAS, not after. `compare_and_set` validates
    // currency and then awaits the medium's own durable write, which on a real
    // disk-backed memento is a filesystem write milliseconds wide. A release landing
    // in that window costs `persist_accepted_save` its currency, so it throws — after
    // the edits are already on disk. Recording afterwards would skip the tombstone
    // for exactly the save that needs one, and the folded live-editor edit (never
    // posted, so nothing the user still has open contains it) would survive into the
    // next session. Uses the real authority store, since the gap lives in the medium.
    it('tombstones a save whose durable write outlived its currency', async () => {
        const file_path = '/tmp/failed-save-persist-race.csv';
        let blob: unknown = {};
        let gate: ReturnType<typeof deferred<void>> | undefined;
        let arm = false;
        const store = create_authority_store({
            runtime_key: {},
            read: () => blob,
            write: async (envelope) => {
                // Suspend inside the medium's write, after the entry is installed.
                if (arm && JSON.stringify(envelope).includes('UNPOSTED')) {
                    arm = false;
                    gate = deferred();
                    await gate.promise;
                }
                blob = envelope;
            },
        });
        const read_pending = async () => (
            (await store.read(file_path)).state as PerFileState
        ).pendingEdits;
        // Two data rows so the folded '1:0' edit validates instead of being rejected.
        vscode_mock.__setReadFileImplementation(async () => enc.encode('h\na\nb\n'));
        vscode_mock.__setWriteFileImplementation(async () => {
            throw new Error('write failed');
        });
        const panel = open_csv_table(uri(file_path), store);
        await panel.__receive({ type: 'ready' });
        await panel.__receive({ type: 'requestEditSession', requestId: 'session-a' });
        const session_a = latest_edit_session_message(panel)!.editSessionId!;

        await panel.__receive({
            type: 'pendingEditsChanged',
            editSessionId: session_a,
            edits: { '0:0': { value: 'A', base: 'a' } },
        });
        await flush_promises();

        // `request_save` folds the open live editor in, so '1:0' was never posted.
        arm = true;
        const save = panel.__receive({
            type: 'saveCsv',
            operation: {
                editSessionId: session_a,
                saveRequestId: 'failed-a',
                edits: { '0:0': 'A', '1:0': 'UNPOSTED' },
                dirtyEdits: {
                    '0:0': { value: 'A', base: 'a' },
                    '1:0': { value: 'UNPOSTED', base: 'b' },
                },
            },
        });
        await flush_promises();
        expect(gate).toBeDefined();

        // The tab closes while that durable write is still in flight.
        const release = panel.__receive({
            type: 'releaseEditSession',
            editSessionId: session_a,
        });
        await flush_promises();
        gate!.resolve();
        await Promise.all([save, release]);
        await flush_promises();

        expect((await read_pending()) ?? {}).not.toHaveProperty('1:0');
        await panel.__receive({ type: 'requestEditSession', requestId: 'session-b' });
        expect(latest_edit_session_message(panel)!.pendingEdits ?? {})
            .not.toHaveProperty('1:0');
    });

    // Discard-then-retype after a failed save. Both discard paths in the webview
    // (`clear_dirty()` on the save-dialog's Discard and on "Discard All") post
    // `edits: null`, and emptying the map is the user moving on from the failed save
    // *more* decisively than replacing it. If an empty post does not retire the
    // lifecycle, the tombstone written at release strips the retyped value even
    // though it is a genuine new edit, and the user's work is destroyed.
    it('retires a failed save on an emptying post so a retyped edit survives', async () => {
        const file_path = '/tmp/failed-save-discard-retype.csv';
        const versioned = state_store();
        vscode_mock.__setWriteFileImplementation(async () => {
            throw new Error('write failed');
        });
        const panel = open_csv_table(uri(file_path), versioned.store);
        await panel.__receive({ type: 'ready' });
        await panel.__receive({ type: 'requestEditSession', requestId: 'session-a' });
        const session_a = latest_edit_session_message(panel)!.editSessionId!;
        const failed_map = { '0:0': { value: 'A', base: 'a' } };
        await panel.__receive({
            type: 'pendingEditsChanged',
            editSessionId: session_a,
            edits: failed_map,
        });
        await flush_promises();
        await panel.__receive({
            type: 'saveCsv',
            operation: {
                editSessionId: session_a,
                saveRequestId: 'failed-a',
                edits: { '0:0': 'A' },
                dirtyEdits: failed_map,
            },
        });
        await flush_promises();

        // Discard everything: the webview posts a null map.
        await panel.__receive({
            type: 'pendingEditsChanged',
            editSessionId: session_a,
            edits: null,
        });
        await flush_promises();
        expect(versioned.get_state(file_path).pendingEdits).toBeUndefined();

        // Then retype the same value. Identical to the failed operation's entry by
        // value, but it is a new edit against a durable state that no longer holds
        // it — nothing here may be mistaken for an echo.
        const retyped = { '0:0': { value: 'A', base: 'a' } };
        await panel.__receive({
            type: 'pendingEditsChanged',
            editSessionId: session_a,
            edits: retyped,
        });
        await flush_promises();

        await panel.__receive({ type: 'releaseEditSession', editSessionId: session_a });
        await flush_promises();
        await panel.__receive({ type: 'requestEditSession', requestId: 'session-b' });
        const grant_b = latest_edit_session_message(panel)!;
        expect(grant_b.granted).toBe(true);
        expect(grant_b.pendingEdits).toEqual(retyped);
        expect(versioned.get_state(file_path).pendingEdits).toEqual(retyped);
    });

    // The partial post: two edits fail together, and the user reverts one of them
    // and keeps the other. Every entry the post carries is one the failed operation
    // owns, so a subset-only comparison reads it as that operation's map echoed
    // back — but the missing key is a deliberate revert, and leaving the tombstone
    // standing would strip the kept edit at release. Only a *complete* echo may
    // preserve the tombstone, which is why the key counts must match.
    it('retires a failed save when a post drops one of its edits', async () => {
        const file_path = '/tmp/failed-save-partial-post.csv';
        const versioned = state_store();
        // Two data rows, so both '0:0' and '1:0' have real bases to validate against.
        // The default 'h\na\n' seed has only one, which makes '1:0' a rowsRemoved
        // rejection — and that path returns before `persist_accepted_save`, so no
        // tombstone is written at all and the key-count guard this test exists to pin
        // is never reached. The guard could then be deleted with the suite still green.
        vscode_mock.__setReadFileImplementation(async () => enc.encode('h\na\nb\n'));
        vscode_mock.__setWriteFileImplementation(async () => {
            throw new Error('write failed');
        });
        const panel = open_csv_table(uri(file_path), versioned.store);
        await panel.__receive({ type: 'ready' });
        await panel.__receive({ type: 'requestEditSession', requestId: 'session-a' });
        const session_a = latest_edit_session_message(panel)!.editSessionId!;
        const failed_map = {
            '0:0': { value: 'A', base: 'a' },
            '1:0': { value: 'B', base: 'b' },
        };
        await panel.__receive({
            type: 'pendingEditsChanged',
            editSessionId: session_a,
            edits: failed_map,
        });
        await flush_promises();
        await panel.__receive({
            type: 'saveCsv',
            operation: {
                editSessionId: session_a,
                saveRequestId: 'failed-a',
                edits: { '0:0': 'A', '1:0': 'B' },
                dirtyEdits: failed_map,
            },
        });
        await flush_promises();

        // Revert '0:0' back to its base, keeping '1:0'. Its entry is byte-identical
        // to the failed operation's, so nothing but the key count distinguishes
        // this post from an echo.
        const kept = { '1:0': { value: 'B', base: 'b' } };
        await panel.__receive({
            type: 'pendingEditsChanged',
            editSessionId: session_a,
            edits: kept,
        });
        await flush_promises();

        await panel.__receive({ type: 'releaseEditSession', editSessionId: session_a });
        await flush_promises();
        await panel.__receive({ type: 'requestEditSession', requestId: 'session-b' });
        const grant_b = latest_edit_session_message(panel)!;
        expect(grant_b.granted).toBe(true);
        expect(grant_b.pendingEdits).toEqual(kept);
        expect(versioned.get_state(file_path).pendingEdits).toEqual(kept);
    });

    // A save rejected *before* `persist_accepted_save` runs leaves nothing durable
    // that belongs to it — the only pending edits on disk are the ones the user's
    // own posts put there. Tombstoning such a save has `ensure_failed_save_cleanup`
    // strip those by value, silently destroying work the user still has open: hit
    // Save on an externally-changed file, read the "try again" warning, close the
    // tab, and the edit is gone. Only a save that reached persistence gets a
    // tombstone, so the whole family of early rejections is covered by this one.
    it('keeps pending edits when a save is rejected before it persists anything', async () => {
        const file_path = '/tmp/pre-persist-rejection-keeps-edits.csv';
        const versioned = state_store();
        const write = vi.fn(async () => {});
        vscode_mock.__setReadFileImplementation(async () => enc.encode('h\na\n'));
        vscode_mock.__setWriteFileImplementation(write);
        const panel = open_csv_table(uri(file_path), versioned.store);
        await panel.__receive({ type: 'ready' });
        await panel.__receive({ type: 'requestEditSession', requestId: 'edit' });
        const session_a = latest_edit_session_message(panel)!.editSessionId!;

        // The user's own edit, posted and made durable by pending-edit persistence.
        const user_map = { '0:0': { value: 'A', base: 'stale' } };
        await panel.__receive({
            type: 'pendingEditsChanged',
            editSessionId: session_a,
            edits: user_map,
        });
        await flush_promises();
        expect(versioned.get_state(file_path).pendingEdits).toEqual(user_map);

        // Save rejected by validate_dirty_bases: base 'stale' was never true.
        // Returns before active_save_operation is set, so nothing is persisted.
        await panel.__receive({
            type: 'saveCsv',
            operation: {
                editSessionId: session_a,
                saveRequestId: 'rejected',
                edits: { '0:0': 'A' },
                dirtyEdits: user_map,
            },
        });
        await flush_promises();
        expect(write).not.toHaveBeenCalled();

        // App re-installs the restore, so the only post available is a complete echo.
        await panel.__receive({
            type: 'pendingEditsChanged',
            editSessionId: session_a,
            edits: user_map,
        });
        await flush_promises();

        // User closes the tab without resolving.
        await panel.__receive({ type: 'releaseEditSession', editSessionId: session_a });
        await flush_promises();
        await panel.__receive({ type: 'requestEditSession', requestId: 'session-b' });
        const grant_b = latest_edit_session_message(panel)!;
        expect(grant_b.granted).toBe(true);
        expect(grant_b.pendingEdits).toEqual(user_map);
        expect(versioned.get_state(file_path).pendingEdits).toEqual(user_map);
    });

    // The tombstone-clearing branch looks unreachable — the handler gates on
    // `edit_message_is_current`, which needs the `owned` phase, and a tombstone only
    // ever exists once `release_edit_session` has moved to `releasing`. But the gate
    // runs when the message *arrives*, while the state write runs later on the
    // `pending_edit_writes` chain, and `update_edit_session_state`'s `is_current`
    // deliberately admits `releasing` so writes admitted before the boundary still
    // land. So a post admitted just before a release finishes after the tombstone is
    // written, with `edit_session_id` still matching it — and a superseding post must
    // drop that tombstone, or `ensure_failed_save_cleanup` strips the newer edit the
    // post just committed.
    it('drops the tombstone for a superseding post admitted before release', async () => {
        const file_path = '/tmp/superseding-post-races-release.csv';
        const versioned = state_store();
        vscode_mock.__setWriteFileImplementation(async () => {
            throw new Error('write failed');
        });
        const panel = open_csv_table(uri(file_path), versioned.store);
        await panel.__receive({ type: 'ready' });
        await panel.__receive({ type: 'requestEditSession', requestId: 'edit' });
        const session_a = latest_edit_session_message(panel)!.editSessionId!;
        const failed_map = { '0:0': { value: 'A', base: 'a' } };
        await panel.__receive({
            type: 'pendingEditsChanged',
            editSessionId: session_a,
            edits: failed_map,
        });
        await flush_promises();
        await panel.__receive({
            type: 'saveCsv',
            operation: {
                editSessionId: session_a,
                saveRequestId: 'failed-a',
                edits: { '0:0': 'A' },
                dirtyEdits: failed_map,
            },
        });
        await flush_promises();

        // Post a superseding edit WITHOUT awaiting, then release in the same tick, so
        // the post is admitted while the phase is still `owned` but its state write
        // runs after `release_edit_session` has written the tombstone.
        //
        // The post *keeps* the operation's own entry and adds a second one. That is
        // what makes the clearing observable: cleanup strips by value, so were the
        // tombstone left standing it would take '0:0' and leave '1:0' behind — a map
        // half of which the user is still actively editing.
        const newer = {
            '0:0': { value: 'A', base: 'a' },
            '1:0': { value: 'B', base: 'b' },
        };
        const post = panel.__receive({
            type: 'pendingEditsChanged',
            editSessionId: session_a,
            edits: newer,
        });
        const release = panel.__receive({
            type: 'releaseEditSession',
            editSessionId: session_a,
        });
        await Promise.all([post, release]);
        await flush_promises();

        // The newer edit survives: the post dropped the tombstone, so the cleanup
        // that runs at the end of the release had nothing to strip.
        await panel.__receive({ type: 'requestEditSession', requestId: 'session-b' });
        const grant_b = latest_edit_session_message(panel)!;
        expect(grant_b.granted).toBe(true);
        expect(grant_b.pendingEdits).toEqual(newer);
        expect(versioned.get_state(file_path).pendingEdits).toEqual(newer);
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

    it('retains visible and dormant highlights across value-only external replacement', async () => {
        const file_path = '/tmp/external-highlight-replacement.csv';
        let bytes = enc.encode('h\na\n');
        let mtime = 1;
        const state = state_store({
            cellHighlights: {
                sourceDigest: source_digest(bytes),
                sheets: [{
                    schema: 'stored-schema',
                    cells: { '0:0': 'yellow', '2:0': 'pink' },
                }],
            },
        });
        vscode_mock.__setReadFileImplementation(async () => bytes);
        vscode_mock.__setStatImplementation(async () => ({ size: bytes.byteLength, mtime }));
        const panel = open_csv_table(uri(file_path), state.store);
        await panel.__receive({ type: 'ready' });
        expect(latest_snapshot(panel).state.cellHighlights?.sheets[0]?.cells)
            .toEqual({ '0:0': 'yellow' });

        bytes = enc.encode('h\nz\n');
        mtime += 1;
        await vscode_mock.__getActiveWatchers()[0].__fireChange(uri(file_path) as never);
        await flush_promises();

        expect(state.get_state(file_path).cellHighlights).toMatchObject({
            sourceDigest: source_digest(bytes),
            sheets: [{ cells: { '0:0': 'yellow', '2:0': 'pink' } }],
        });
        expect(latest_snapshot(panel).state.cellHighlights).toMatchObject({
            sourceDigest: source_digest(bytes),
            sheets: [{ cells: { '0:0': 'yellow' } }],
        });
    });

    it('reconciles stale highlight digests on reopen and remains stable on another reopen', async () => {
        const file_path = '/tmp/reopen-stale-highlights.csv';
        let bytes = enc.encode('h\na\n');
        let mtime = 1;
        const state = state_store({
            cellHighlights: {
                sourceDigest: source_digest(bytes),
                sheets: [{
                    schema: 'stored-schema',
                    cells: { '0:0': 'green', '4:0': 'blue' },
                }],
            },
        });
        vscode_mock.__setReadFileImplementation(async () => bytes);
        vscode_mock.__setStatImplementation(async () => ({ size: bytes.byteLength, mtime }));
        const first = open_csv_table(uri(file_path), state.store);
        await first.__receive({ type: 'ready' });
        first.dispose();

        bytes = enc.encode('h\nreplaced\n');
        mtime += 1;
        const reopened = open_csv_table(uri(file_path), state.store);
        await reopened.__receive({ type: 'ready' });
        expect(state.get_state(file_path).cellHighlights).toMatchObject({
            sourceDigest: source_digest(bytes),
            sheets: [{ cells: { '0:0': 'green', '4:0': 'blue' } }],
        });
        expect(latest_snapshot(reopened).state.cellHighlights?.sheets[0]?.cells)
            .toEqual({ '0:0': 'green' });
        reopened.dispose();

        const stable = open_csv_table(uri(file_path), state.store);
        await stable.__receive({ type: 'ready' });
        expect(state.get_state(file_path).cellHighlights).toMatchObject({
            sourceDigest: source_digest(bytes),
            sheets: [{ cells: { '0:0': 'green', '4:0': 'blue' } }],
        });
        expect(latest_snapshot(stable).state.cellHighlights?.sheets[0]?.cells)
            .toEqual({ '0:0': 'green' });
    });

    it('keeps full durable highlights through multi-panel layout echoes and refreshes', async () => {
        const file_path = '/tmp/multi-panel-dormant-highlights.csv';
        let bytes = enc.encode('h\na\n');
        let mtime = 1;
        const state = state_store({
            cellHighlights: {
                sourceDigest: source_digest(bytes),
                sheets: [{
                    schema: 'stored-schema',
                    cells: { '0:0': 'yellow', '2:0': 'pink' },
                }],
            },
        });
        vscode_mock.__setReadFileImplementation(async () => bytes);
        vscode_mock.__setStatImplementation(async () => ({ size: bytes.byteLength, mtime }));
        const first = open_csv_table(uri(file_path), state.store);
        const second = open_csv_table(uri(file_path), state.store);
        await first.__receive({ type: 'ready' });
        await second.__receive({ type: 'ready' });
        const first_snapshot = latest_snapshot(first);
        const second_snapshot = latest_snapshot(second);
        expect(first_snapshot.state.cellHighlights?.sheets[0]?.cells)
            .toEqual({ '0:0': 'yellow' });
        expect(second_snapshot.state.cellHighlights?.sheets[0]?.cells)
            .toEqual({ '0:0': 'yellow' });
        await first.__receive({
            type: 'snapshotApplied',
            identity: first_snapshot.identity,
            disposition: 'applied',
        });
        await second.__receive({
            type: 'snapshotApplied',
            identity: second_snapshot.identity,
            disposition: 'applied',
        });
        await first.__receive({
            type: 'stateChanged',
            sourceGeneration: first_snapshot.sourceGeneration,
            snapshotIdentity: first_snapshot.identity,
            state: {
                ...first_snapshot.state,
                columnWidths: [{ 0: 177 }],
            },
        });
        expect(state.get_state(file_path)).toMatchObject({
            columnWidths: [{ 0: 177 }],
            cellHighlights: {
                sheets: [{ cells: { '0:0': 'yellow', '2:0': 'pink' } }],
            },
        });

        bytes = enc.encode('h\na\nb\nc\n');
        mtime += 1;
        await vscode_mock.__getActiveWatchers()[0].__fireChange(uri(file_path) as never);
        await flush_promises();
        expect(state.get_state(file_path).cellHighlights).toMatchObject({
            sourceDigest: source_digest(bytes),
            sheets: [{ cells: { '0:0': 'yellow', '2:0': 'pink' } }],
        });
        expect(latest_snapshot(first).state.cellHighlights?.sheets[0]?.cells)
            .toEqual({ '0:0': 'yellow', '2:0': 'pink' });
        expect(latest_snapshot(second).state.cellHighlights?.sheets[0]?.cells)
            .toEqual({ '0:0': 'yellow', '2:0': 'pink' });
    });

    it('publishes exact authoritative selection clears to origin and sibling panels', async () => {
        const file_path = '/tmp/two-panel-highlights.csv';
        const bytes = enc.encode('h\na\nb\n');
        const state = state_store({
            rowHeights: [{ 0: 28 }],
            cellHighlights: {
                sourceDigest: source_digest(bytes),
                sheets: [{
                    schema: 'stored-schema',
                    cells: {
                        '0:0': 'yellow',
                        '1:0': 'green',
                        '9:0': 'pink',
                    },
                }],
            },
        });
        vscode_mock.__setReadFileImplementation(async () => bytes);
        vscode_mock.__setStatImplementation(async () => ({ size: bytes.byteLength, mtime: 1 }));
        const first = open_csv_table(uri(file_path), state.store);
        const second = open_csv_table(uri(file_path), state.store);
        await first.__receive({ type: 'ready' });
        await second.__receive({ type: 'ready' });
        const first_snapshot = latest_snapshot(first);
        const second_snapshot = latest_snapshot(second);
        await first.__receive({
            type: 'snapshotApplied',
            identity: first_snapshot.identity,
            disposition: 'applied',
        });
        await second.__receive({
            type: 'snapshotApplied',
            identity: second_snapshot.identity,
            disposition: 'applied',
        });

        await first.__receive({
            type: 'applyCellHighlights',
            sheetIndex: 0,
            sheetName: 'Sheet1',
            selection: { displayRows: [{ start: 0, end: 0 }], sourceColumns: [0] },
            mutation: { type: 'clear' },
            requestId: 'highlight:clear',
            generation: first_snapshot.generation,
            sourceGeneration: first_snapshot.sourceGeneration,
            snapshotIdentity: first_snapshot.identity,
        });
        await flush_promises();

        expect(state.get_state(file_path)).toMatchObject({
            rowHeights: [{ 0: 28 }],
            cellHighlights: {
                sheets: [{ cells: { '1:0': 'green', '9:0': 'pink' } }],
            },
        });
        const origin = first.__messages.filter((message: any) => (
            message?.type === 'cellHighlightsChanged'
        )).at(-1) as any;
        const sibling = second.__messages.filter((message: any) => (
            message?.type === 'cellHighlightsChanged'
        )).at(-1) as any;
        expect(origin).toMatchObject({
            requestId: 'highlight:clear',
            sheetIndex: 0,
            state: { sheets: [{ cells: { '1:0': 'green' } }] },
        });
        expect(sibling).toMatchObject({
            sheetIndex: 0,
            stateRevision: origin.stateRevision,
            physicalRevision: origin.physicalRevision,
            state: origin.state,
        });
        expect(sibling.requestId).toBeUndefined();
    });

    it('rejects stale clear-all then clears full durable state for both panels', async () => {
        const file_path = '/tmp/two-panel-clear-all-highlights.csv';
        const bytes = enc.encode('h\na\nb\n');
        const state = state_store({
            rowHeights: [{ 0: 36 }],
            cellHighlights: {
                sourceDigest: source_digest(bytes),
                sheets: [{
                    schema: 'stored-schema',
                    cells: { '0:0': 'yellow', '9:0': 'pink' },
                }, {
                    schema: 'absent-sheet',
                    cells: { '0:0': 'blue' },
                }],
            },
        });
        vscode_mock.__setReadFileImplementation(async () => bytes);
        vscode_mock.__setStatImplementation(async () => ({ size: bytes.byteLength, mtime: 1 }));
        const first = open_csv_table(uri(file_path), state.store);
        const second = open_csv_table(uri(file_path), state.store);
        await first.__receive({ type: 'ready' });
        await second.__receive({ type: 'ready' });
        const first_snapshot = latest_snapshot(first);
        const second_snapshot = latest_snapshot(second);
        await first.__receive({
            type: 'snapshotApplied',
            identity: first_snapshot.identity,
            disposition: 'applied',
        });
        await second.__receive({
            type: 'snapshotApplied',
            identity: second_snapshot.identity,
            disposition: 'applied',
        });

        await first.__receive({
            type: 'clearAllCellHighlights',
            requestId: 'clear-all:stale',
            generation: first_snapshot.generation + 1,
            sourceGeneration: first_snapshot.sourceGeneration,
            snapshotIdentity: first_snapshot.identity,
        });
        const rejected = first.__messages.filter((message: any) => (
            message?.type === 'cellHighlightsChanged'
            && message.requestId === 'clear-all:stale'
        )).at(-1) as any;
        expect(rejected).toMatchObject({
            state: { sheets: [{ cells: { '0:0': 'yellow' } }] },
            error: 'The workbook changed before the highlight request arrived.',
        });
        expect(rejected.sheetIndex).toBeUndefined();
        expect(state.get_state(file_path).cellHighlights?.sheets[1]?.cells)
            .toEqual({ '0:0': 'blue' });

        await first.__receive({
            type: 'clearAllCellHighlights',
            requestId: 'clear-all:current',
            generation: first_snapshot.generation,
            sourceGeneration: first_snapshot.sourceGeneration,
            snapshotIdentity: first_snapshot.identity,
        });
        await flush_promises();
        expect(state.get_state(file_path)).toMatchObject({
            rowHeights: [{ 0: 36 }],
        });
        expect(state.get_state(file_path).cellHighlights).toBeUndefined();

        const origin = first.__messages.filter((message: any) => (
            message?.type === 'cellHighlightsChanged'
            && message.requestId === 'clear-all:current'
        )).at(-1) as any;
        const sibling = second.__messages.filter((message: any) => (
            message?.type === 'cellHighlightsChanged'
            && message.requestId === undefined
            && message.state === undefined
        )).at(-1) as any;
        expect(origin).toMatchObject({
            state: undefined,
            stateRevision: expect.any(Number),
            physicalRevision: first_snapshot.identity.sourceBasis.physicalRevision,
        });
        expect(origin.sheetIndex).toBeUndefined();
        expect(sibling).toMatchObject({
            state: undefined,
            stateRevision: origin.stateRevision,
            physicalRevision: origin.physicalRevision,
        });
        expect(sibling.sheetIndex).toBeUndefined();
    });

    it('rejects stale, wrong-sheet, and preview highlight authorities without mutation', async () => {
        const file_path = '/tmp/rejected-highlights.csv';
        const state = state_store();
        const panel = open_csv_table(uri(file_path), state.store);
        await panel.__receive({ type: 'ready' });
        const snapshot = latest_snapshot(panel);
        await panel.__receive({
            type: 'snapshotApplied', identity: snapshot.identity, disposition: 'applied',
        });
        const base = {
            type: 'applyCellHighlights' as const,
            sheetIndex: 0,
            sheetName: 'Sheet1',
            selection: { displayRows: [{ start: 0, end: 0 }], sourceColumns: [0] },
            mutation: { type: 'set' as const, color: 'yellow' as const },
            generation: snapshot.generation,
            sourceGeneration: snapshot.sourceGeneration,
            snapshotIdentity: snapshot.identity,
        };
        await panel.__receive({ ...base, requestId: 'stale', generation: snapshot.generation + 1 });
        await panel.__receive({ ...base, requestId: 'wrong-sheet', sheetName: 'Other' });
        expect(panel.__messages.filter((message: any) => (
            message?.type === 'cellHighlightsChanged' && message.error
        )).slice(-2).map((message: any) => message.requestId)).toEqual([
            'stale', 'wrong-sheet',
        ]);
        expect(state.get_state(file_path).cellHighlights).toBeUndefined();

        const preview_profile: ViewerProfile = {
            editing: false,
            previewMode: true,
            build_source: async () => new StubSource(),
        };
        const preview = open_csv_table(uri('/tmp/preview-highlights.csv'), state.store, preview_profile);
        await preview.__receive({ type: 'ready' });
        const preview_snapshot = latest_snapshot(preview);
        await preview.__receive({
            type: 'snapshotApplied',
            identity: preview_snapshot.identity,
            disposition: 'applied',
        });
        await preview.__receive({
            ...base,
            requestId: 'preview',
            generation: preview_snapshot.generation,
            sourceGeneration: preview_snapshot.sourceGeneration,
            snapshotIdentity: preview_snapshot.identity,
        });
        expect(preview.__messages).toContainEqual(expect.objectContaining({
            type: 'cellHighlightsChanged',
            requestId: 'preview',
            error: 'Cell highlights cannot be changed from a preview.',
        }));
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

        const restore_ack = transform_installs(first)[0];
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
        expect(restore_ack.view.basis.generation).toBeGreaterThan(meta.generation);
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
        expect(transform_answers(panel)).toEqual([]);

        gate.resolve();
        await cancel;
        expect(current.transforms).toEqual([undefined]);
        expect(transform_answers(panel)).toHaveLength(1);
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
        expect(transform_answers(panel)).toEqual([]);
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
        const applied = basis_of(transform_installs(panel).at(-1)!);

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
        expect(transform_answers(panel).some((message) => (
            message.requestId === 'clear-transform'
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
        const installed = basis_of(transform_installs(panel).filter((message) => (
            message.requestId === 'install-preferred'
        )).at(-1)!);

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
        expect(error).not.toHaveBeenCalled();
    });

    it('durably removes only the invalid numeric transform and does not retry it on reopen', async () => {
        const file_path = '/tmp/invalid-saved-numeric-filter.csv';
        const invalid = {
            sort: [],
            filters: [{
                id: 'invalid', colIndex: 0, operator: 'greaterThan' as const,
                value: 'not-a-number', caseSensitive: false, enabled: true,
            }],
            schema: '["Sheet1",2,null]',
        };
        const other = {
            sort: [{ colIndex: 1, direction: 'desc' as const }],
            filters: [],
            schema: '["Sheet2",2,null]',
        };
        const versioned = state_store({
            transforms: [invalid, other],
            columnWidths: [{ 0: 123 }, { 1: 234 }],
        });
        let reads = 0;
        const profile: ViewerProfile = {
            editing: false,
            async build_source() {
                return new class extends TwoSheetSource {
                    override read_rows(sheet: number, start: number, count: number) {
                        reads += 1;
                        if (sheet === 0) {
                            return {
                                startRow: 0,
                                rows: [[{
                                    raw: '1', rawType: 'number' as const, formatted: '1',
                                    bold: false, italic: false,
                                }, null]],
                            };
                        }
                        return super.read_rows(sheet, start, count);
                    }
                }();
            },
        };
        const error = vi.spyOn(console, 'error').mockImplementation(() => {});
        const panel = open_csv_table(uri(file_path), versioned.store, profile);
        await panel.__receive({ type: 'ready' });
        await panel.__receive({ type: 'ready' });

        expect(versioned.get_state(file_path)).toMatchObject({
            transforms: [undefined, other],
            columnWidths: [{ 0: 123 }, { 1: 234 }],
        });
        const reads_after_cleanup = reads;
        await panel.__receive({ type: 'ready' });
        expect(reads).toBe(reads_after_cleanup);
        expect(error).not.toHaveBeenCalled();
        expect(latest_snapshot(panel).state.transforms).toEqual([undefined, other]);
    });

    it('cleans more than the ready rebase limit of independently invalid sheets', async () => {
        const file_path = '/tmp/many-invalid-saved-filters.csv';
        const sheet_count = 20;
        const transforms = Array.from({ length: sheet_count }, (_, index) => ({
            sort: [],
            filters: [{
                id: `invalid-${index}`, colIndex: 0,
                operator: 'greaterThan' as const, value: 'bad',
                caseSensitive: false, enabled: true,
            }],
            schema: JSON.stringify([`Sheet${index + 1}`, 1, null]),
        }));
        const versioned = state_store({ transforms });
        const profile: ViewerProfile = {
            editing: false,
            async build_source() {
                return new class extends StubSource {
                    override meta(): WorkbookMeta {
                        return {
                            hasFormatting: false,
                            sheets: Array.from({ length: sheet_count }, (_, index) => ({
                                name: `Sheet${index + 1}`,
                                rowCount: 1,
                                sourceRowCount: 1,
                                columnCount: 1,
                                merges: [],
                                hasFormatting: false,
                            })),
                        };
                    }
                    override read_rows(sheet: number): RowWindow {
                        return {
                            startRow: 0,
                            rows: [[{
                                raw: String(sheet), rawType: 'number',
                                formatted: String(sheet), bold: false, italic: false,
                            }]],
                        };
                    }
                }();
            },
        };
        const error = vi.spyOn(console, 'error').mockImplementation(() => {});
        const panel = open_csv_table(uri(file_path), versioned.store, profile);
        await panel.__receive({ type: 'ready' });
        await panel.__receive({ type: 'ready' });

        expect(versioned.get_state(file_path).transforms)
            .toEqual(Array.from({ length: sheet_count }, () => undefined));
        expect(versioned.revision(file_path)).toBe(sheet_count);
        expect(error).not.toHaveBeenCalledWith(
            expect.stringContaining('kept changing during ready'),
        );
    });

    it('bounds repeated invalid-state reintroduction on one sheet during ready', async () => {
        const file_path = '/tmp/reintroduced-invalid-ready-filter.csv';
        const invalid = {
            sort: [], filters: [{
                id: 'invalid', colIndex: 0, operator: 'greaterThan' as const,
                value: 'bad', caseSensitive: false, enabled: true,
            }], schema: '["Sheet1",1,null]',
        };
        const versioned = state_store({ transforms: [invalid] });
        let cleanup_commits = 0;
        const store: FileStateStore = {
            ...versioned.store,
            async compare_and_set(path, expected, next, validate) {
                const result = await versioned.store.compare_and_set(
                    path, expected, next, validate,
                );
                if (result.type === 'committed' && next.transforms?.[0] === undefined) {
                    cleanup_commits += 1;
                    const current = await versioned.store.read(path);
                    await versioned.store.compare_and_set(path, current.revision, {
                        ...(current.state as PerFileState), transforms: [invalid],
                    });
                }
                return result;
            },
        };
        const profile: ViewerProfile = {
            editing: false,
            async build_source() { return new SignallingInvalidFilterSource(() => {}); },
        };
        const error = vi.spyOn(console, 'error').mockImplementation(() => {});
        const panel = open_csv_table(uri(file_path), store, profile);
        await panel.__receive({ type: 'ready' });
        await panel.__receive({ type: 'ready' });

        // One credited forward-progress cleanup, then the 16 normal rebases.
        expect(cleanup_commits).toBe(17);
        expect(versioned.get_state(file_path).transforms).toEqual([invalid]);
        expect(error).toHaveBeenCalledWith(
            'Table viewer state kept changing during ready; using retained state',
        );
    });

    it('keeps invalid ready state after cleanup persistence fails and clears it on retry', async () => {
        const file_path = '/tmp/ready-invalid-cleanup-retry.csv';
        const invalid = {
            sort: [], filters: [{
                id: 'invalid', colIndex: 0, operator: 'greaterThan' as const,
                value: 'bad', caseSensitive: false, enabled: true,
            }], schema: '["Sheet1",1,null]',
        };
        const versioned = state_store({ transforms: [invalid] });
        let fail_cleanup = true;
        const store: FileStateStore = {
            ...versioned.store,
            async compare_and_set(path, expected, next, validate) {
                if (fail_cleanup && next.transforms?.[0] === undefined) {
                    fail_cleanup = false;
                    throw new Error('transient ready cleanup persistence failure');
                }
                return versioned.store.compare_and_set(path, expected, next, validate);
            },
        };
        const profile: ViewerProfile = {
            editing: false,
            async build_source() { return new SignallingInvalidFilterSource(() => {}); },
        };
        const error = vi.spyOn(console, 'error').mockImplementation(() => {});
        const panel = open_csv_table(uri(file_path), store, profile);
        await panel.__receive({ type: 'ready' });
        await panel.__receive({ type: 'ready' });
        expect(versioned.get_state(file_path).transforms).toEqual([invalid]);
        expect(latest_snapshot(panel).state.transforms).toEqual([invalid]);
        expect(error).toHaveBeenCalledWith(
            'Failed to clear an invalid saved table transform',
            expect.objectContaining({ message: 'transient ready cleanup persistence failure' }),
        );

        await panel.__receive({ type: 'ready' });
        expect(versioned.get_state(file_path).transforms).toEqual([undefined]);
        expect(latest_snapshot(panel).state.transforms).toEqual([undefined]);
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

        const ack = transform_answers(panel)[0];
        expect(ack).toMatchObject({
            type: 'transformRefused',
            reason: expect.stringContaining('column read failed'),
        });
        expect(state.get_state(file_path).transforms).toEqual([saved_transform]);
    });

    it('cleans an explicit invalid numeric restore before acknowledging it', async () => {
        const file_path = '/tmp/explicit-invalid-restore.csv';
        const saved_transform = {
            // Deliberately reverse insertion order from sanitizer output. CAS
            // ownership must use transform semantics, not JSON object order.
            schema: '["Sheet1",1,null]',
            filters: [{
                enabled: true, caseSensitive: false, value: 'bad',
                operator: 'greaterThan' as const, colIndex: 0, id: 'invalid',
            }],
            sort: [],
        };
        const state = state_store({ transforms: [saved_transform] });
        const profile: ViewerProfile = {
            editing: false,
            async build_source() { return new SignallingInvalidFilterSource(() => {}); },
        };
        const panel = open_csv_table(uri(file_path), state.store, profile);
        await panel.__receive({ type: 'ready' });
        const snapshot = latest_snapshot(panel);
        panel.__messages.length = 0;

        await panel.__receive({
            type: 'setTransform', sheetIndex: 0, requestId: 'invalid-restore',
            generation: snapshot.generation,
            sourceGeneration: snapshot.sourceGeneration,
            intent: 'restore', state: saved_transform,
        });

        // A recovered invalid restore is an install of the view that stands, so the
        // webview stops asking for the rules the host has just dropped durably.
        const ack = transform_answers(panel)[0];
        expect(ack).toMatchObject({
            type: 'transformInstalled',
            view: { rules: undefined, permuted: false },
        });
        expect(state.get_state(file_path).transforms).toEqual([undefined]);
    });

    it('reports an explicit cleanup persistence failure and recovers on retry', async () => {
        const file_path = '/tmp/explicit-invalid-restore-cleanup-retry.csv';
        const invalid = {
            sort: [], filters: [{
                id: 'invalid', colIndex: 0, operator: 'greaterThan' as const,
                value: 'bad', caseSensitive: false, enabled: true,
            }], schema: '["Sheet1",1,null]',
        };
        const versioned = state_store({ transforms: [invalid] });
        let fail_cleanup = true;
        const store: FileStateStore = {
            ...versioned.store,
            async compare_and_set(path, expected, next, validate) {
                if (fail_cleanup && next.transforms?.[0] === undefined) {
                    fail_cleanup = false;
                    throw new Error('transient cleanup persistence failure');
                }
                return versioned.store.compare_and_set(path, expected, next, validate);
            },
        };
        const profile: ViewerProfile = {
            editing: false,
            async build_source() { return new SignallingInvalidFilterSource(() => {}); },
        };
        const error = vi.spyOn(console, 'error').mockImplementation(() => {});
        const panel = open_csv_table(uri(file_path), store, profile);
        await panel.__receive({ type: 'ready' });
        const snapshot = latest_snapshot(panel);
        const restore = (requestId: string) => panel.__receive({
            type: 'setTransform' as const, sheetIndex: 0, requestId,
            generation: snapshot.generation,
            sourceGeneration: snapshot.sourceGeneration,
            intent: 'restore' as const, state: invalid,
        });

        panel.__messages.length = 0;
        await restore('failed-cleanup');
        const failed = transform_answers(panel)[0];
        expect(failed).toMatchObject({
            type: 'transformRefused',
            reason: expect.stringContaining('finite numbers'),
            terminal: true,
        });
        expect(versioned.get_state(file_path).transforms).toEqual([invalid]);
        expect(error).toHaveBeenCalledWith(
            'Failed to clear an invalid saved table transform',
            expect.objectContaining({ message: 'transient cleanup persistence failure' }),
        );

        panel.__messages.length = 0;
        await restore('successful-retry');
        expect(transform_answers(panel)[0].type).toBe('transformInstalled');
        expect(versioned.get_state(file_path).transforms).toEqual([undefined]);
    });

    it('does not clear the same invalid saved filter from a different sheet', async () => {
        const file_path = '/tmp/one-sheet-invalid-restore-cleanup.csv';
        const filter = {
            id: 'same-invalid', colIndex: 0, operator: 'greaterThan' as const,
            value: 'bad', caseSensitive: false, enabled: true,
        };
        const first = {
            sort: [], filters: [filter], schema: '["Sheet1",2,null]',
        };
        const second = {
            sort: [], filters: [filter], schema: '["Sheet2",2,null]',
        };
        const state = state_store({ transforms: [first, second] });
        const profile: ViewerProfile = {
            editing: false,
            async build_source() {
                return new class extends TwoSheetSource {
                    override read_rows(sheet: number): RowWindow {
                        return {
                            startRow: 0,
                            rows: [[{
                                raw: String(sheet + 1), rawType: 'number',
                                formatted: String(sheet + 1), bold: false, italic: false,
                            }, null]],
                        };
                    }
                }();
            },
        };
        const error = vi.spyOn(console, 'error').mockImplementation(() => {});
        const panel = open_csv_table(uri(file_path), state.store, profile);
        await panel.__receive({ type: 'ready' });
        const snapshot = latest_snapshot(panel);

        await panel.__receive({
            type: 'setTransform', sheetIndex: 0, requestId: 'first-sheet-only',
            generation: snapshot.generation,
            sourceGeneration: snapshot.sourceGeneration,
            intent: 'restore', state: first,
        });

        expect(state.get_state(file_path).transforms).toEqual([undefined, second]);
        expect(error).toHaveBeenCalledWith(
            expect.stringContaining('Failed to reconcile durable table transforms'),
            expect.any(InvalidPersistedTransformError),
        );
    });

    it('adopts a newer transform that wins the invalid-restore cleanup CAS', async () => {
        const file_path = '/tmp/invalid-restore-cas-winner.csv';
        const invalid = {
            sort: [], filters: [{
                id: 'invalid', colIndex: 0, operator: 'greaterThan' as const,
                value: 'bad', caseSensitive: false, enabled: true,
            }], schema: '["Sheet1",1,null]',
        };
        const winner = {
            sort: [{ colIndex: 0, direction: 'desc' as const }],
            filters: [], schema: invalid.schema,
        };
        const versioned = state_store({ transforms: [invalid], rowHeights: [{ 0: 27 }] });
        let inject_winner = true;
        const store: FileStateStore = {
            ...versioned.store,
            async compare_and_set(path, expected, next, validate) {
                if (inject_winner && next.transforms?.[0] === undefined) {
                    inject_winner = false;
                    const current = await versioned.store.read(path);
                    await versioned.store.compare_and_set(path, current.revision, {
                        ...(current.state as PerFileState),
                        transforms: [winner],
                    });
                }
                return versioned.store.compare_and_set(path, expected, next, validate);
            },
        };
        const profile: ViewerProfile = {
            editing: false,
            async build_source() { return new SignallingInvalidFilterSource(() => {}); },
        };
        const panel = open_csv_table(uri(file_path), store, profile);
        await panel.__receive({ type: 'ready' });
        const snapshot = latest_snapshot(panel);
        panel.__messages.length = 0;

        await panel.__receive({
            type: 'setTransform', sheetIndex: 0, requestId: 'losing-restore',
            generation: snapshot.generation,
            sourceGeneration: snapshot.sourceGeneration,
            intent: 'restore', state: invalid,
        });

        expect(versioned.get_state(file_path)).toMatchObject({
            transforms: [winner], rowHeights: [{ 0: 27 }],
        });
        expect(transform_answers(panel)[0].type).toBe('transformInstalled');
    });

    it('retries invalid-restore cleanup after an unrelated CAS winner', async () => {
        const file_path = '/tmp/invalid-restore-cas-retry.csv';
        const invalid = {
            sort: [], filters: [{
                id: 'invalid', colIndex: 0, operator: 'greaterThan' as const,
                value: 'bad', caseSensitive: false, enabled: true,
            }], schema: '["Sheet1",1,null]',
        };
        const versioned = state_store({ transforms: [invalid] });
        let cleanup_attempts = 0;
        const store: FileStateStore = {
            ...versioned.store,
            async compare_and_set(path, expected, next, validate) {
                if (next.transforms?.[0] === undefined) {
                    cleanup_attempts += 1;
                    if (cleanup_attempts === 1) {
                        const current = await versioned.store.read(path);
                        await versioned.store.compare_and_set(path, current.revision, {
                            ...(current.state as PerFileState),
                            columnWidths: [{ 0: 144 }],
                        });
                    }
                }
                return versioned.store.compare_and_set(path, expected, next, validate);
            },
        };
        const profile: ViewerProfile = {
            editing: false,
            async build_source() { return new SignallingInvalidFilterSource(() => {}); },
        };
        const panel = open_csv_table(uri(file_path), store, profile);
        await panel.__receive({ type: 'ready' });
        const snapshot = latest_snapshot(panel);

        await panel.__receive({
            type: 'setTransform', sheetIndex: 0, requestId: 'retry-restore',
            generation: snapshot.generation,
            sourceGeneration: snapshot.sourceGeneration,
            intent: 'restore', state: invalid,
        });

        expect(cleanup_attempts).toBe(2);
        expect(versioned.get_state(file_path)).toMatchObject({
            transforms: [undefined],
            columnWidths: [{ 0: 144 }],
        });
    });

    it('admits a transform from the panel that owns the edit session', async () => {
        const file_path = '/tmp/owner-transform-admitted.csv';
        const state = state_store();
        vscode_mock.__setReadFileImplementation(async () => enc.encode('h\nc\na\nb\n'));
        const panel = open_csv_table(uri(file_path), state.store);
        await panel.__receive({ type: 'ready' });
        await panel.__receive({ type: 'requestEditSession' } as never);
        expect(edit_session_results(panel).at(-1)?.granted).toBe(true);
        const snapshot = latest_snapshot(panel);

        await panel.__receive({
            type: 'setTransform',
            sheetIndex: 0,
            requestId: 'owner-sort',
            generation: snapshot.generation,
            sourceGeneration: snapshot.sourceGeneration,
            intent: 'user',
            state: {
                sort: [{ colIndex: 0, direction: 'asc' }],
                filters: [],
                schema: '["Sheet1",1,["h"]]',
            },
        });

        const applied = basis_of(transform_installs(panel).find((message) => (
            message.requestId === 'owner-sort'
        ))!);
        expect(state.get_state(file_path).transforms?.[0]?.sort).toEqual([
            { colIndex: 0, direction: 'asc' },
        ]);

        // The owner's own view really is sorted: admission is not a silent no-op.
        await panel.__receive({
            type: 'requestRows', sheetIndex: 0, startRow: 0, count: 3,
            requestId: 'owner-sorted-rows', generation: applied.generation,
        });
        const rows = panel.__messages.find((message) => (
            typeof message === 'object'
            && message !== null
            && 'type' in message
            && message.type === 'rowData'
            && 'requestId' in message
            && message.requestId === 'owner-sorted-rows'
        )) as { rows: Array<Array<{ raw: string }>> };
        expect(rows.rows.map((row) => row[0].raw)).toEqual(['a', 'b', 'c']);
    });

    it('keeps csvEditable true after the owning panel installs a transform', async () => {
        // Without this the webview's `edit_mode && !csv_editable` guard would eject
        // the user from edit mode the instant their own sort landed, so admission
        // would undo itself. A transform alone re-projects nothing, so the stale
        // capability rides along until something recaptures — and the very next
        // thing the user does after sorting is keep typing. That posts
        // pendingEditsChanged, whose notify_edit_state recaptures the projection
        // with the owner's own transform installed, which is exactly where the
        // capability would flip false.
        const file_path = '/tmp/owner-transform-capability.csv';
        const state = state_store();
        const bytes = enc.encode('h\nc\na\nb\n');
        vscode_mock.__setStatImplementation(async () => ({
            size: bytes.byteLength, mtime: 1,
        }));
        vscode_mock.__setReadFileImplementation(async () => bytes);
        const panel = open_csv_table(uri(file_path), state.store);
        await panel.__receive({ type: 'ready' });
        await panel.__receive({ type: 'requestEditSession' } as never);
        const edit_session_id = latest_edit_session_message(panel)!.editSessionId!;
        const snapshot = latest_snapshot(panel);
        expect(snapshot.capabilities.csvEditable).toBe(true);

        await panel.__receive({
            type: 'setTransform',
            sheetIndex: 0,
            requestId: 'capability-sort',
            generation: snapshot.generation,
            sourceGeneration: snapshot.sourceGeneration,
            intent: 'user',
            state: {
                sort: [{ colIndex: 0, direction: 'asc' }],
                filters: [],
                schema: '["Sheet1",1,["h"]]',
            },
        });
        expect(state.get_state(file_path).transforms?.[0]?.sort).toEqual([
            { colIndex: 0, direction: 'asc' },
        ]);
        panel.__messages.length = 0;

        await panel.__receive({
            type: 'pendingEditsChanged',
            editSessionId: edit_session_id,
            edits: { '0:0': { value: 'still-editing', base: 'c' } },
        });
        await flush_promises();
        const after = latest_snapshot(panel);
        expect(after.capabilities.csvEditable).toBe(true);
        expect(after.capabilities.csvEditSessionId).toBe(edit_session_id);
    });

    it('refuses a sibling transform because another panel owns the edit session', async () => {
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

        // The owner may sort its own view; a sibling may not, because recomputing
        // the permutation would move the owner's rows mid-edit.
        expect(shared.get_state(file_path).transforms).toBeUndefined();
        expect(sibling.__messages).toContainEqual(expect.objectContaining({
            type: 'transformRefused',
            requestId: 'sibling-during-edit',
            reason: 'Another panel is editing this file.',
            // The other panel's session ends, so this is worth retrying and the
            // sibling keeps its own copy of the request; there is nothing of ours it
            // could adopt instead.
            terminal: false,
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
            type: 'transformRefused',
            requestId: 'overtaking-transform',
            reason: 'Finishing edit-session work; try again in a moment.',
        }));
    });

    // The two halves of what used to be one test. Transform *work in flight* is
    // file-level concurrency and still refuses a sibling's claim; a transform a
    // sibling merely *installed* does not, because edits are source-keyed and an
    // installed permutation never recomputes during a live session.
    it('does not grant a sibling edit claim while a sibling transform is in flight', async () => {
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

        expect(edit_session_results(claimant)).toEqual([
            { type: 'editSessionResult', granted: false },
        ]);
    });

    it('grants a sibling edit claim once the sibling transform has installed', async () => {
        const file_path = '/tmp/cross-panel-installed-transform-edit.csv';
        const shared = state_store();
        const transformer = open_csv_table(uri(file_path), shared.store);
        const claimant = open_csv_table(uri(file_path), shared.store);
        await transformer.__receive({ type: 'ready' });
        await claimant.__receive({ type: 'ready' });
        const snapshot = latest_snapshot(transformer);

        await transformer.__receive({
            type: 'setTransform',
            sheetIndex: 0,
            requestId: 'installed-transform',
            generation: snapshot.generation,
            sourceGeneration: snapshot.sourceGeneration,
            intent: 'user',
            state: {
                sort: [{ colIndex: 0, direction: 'asc' }],
                filters: [],
                schema: '["Sheet1",1,["h"]]',
            },
        });
        expect(transformer.__messages).toContainEqual(expect.objectContaining({
            type: 'transformInstalled',
            requestId: 'installed-transform',
        }));
        // The transform really is installed, so this is not the vacuous case of a
        // request that never landed.
        expect(shared.get_state(file_path).transforms?.[0]?.sort).toEqual([
            { colIndex: 0, direction: 'asc' },
        ]);

        await claimant.__receive({ type: 'requestEditSession' } as never);

        expect(edit_session_results(claimant)).toEqual([
            { type: 'editSessionResult', granted: true },
        ]);
        // And the sibling's installed transform survives the grant untouched.
        expect(shared.get_state(file_path).transforms?.[0]?.sort).toEqual([
            { colIndex: 0, direction: 'asc' },
        ]);
    });

    it('enters edit mode under an installed sort without moving any row', async () => {
        // The product guarantee for this direction: opening edit mode on an
        // already-sorted sheet must not eject the sort, and must not shuffle the
        // rows the user is looking at. The permutation is simply carried in.
        const file_path = '/tmp/enter-edit-under-installed-sort.csv';
        const shared = state_store();
        const bytes = enc.encode('h\nc\na\nb\n');
        vscode_mock.__setStatImplementation(async () => ({
            size: bytes.byteLength, mtime: 1,
        }));
        vscode_mock.__setReadFileImplementation(async () => bytes);
        const warning = vi.spyOn(vscode_mock.window, 'showWarningMessage');
        const panel = open_csv_table(uri(file_path), shared.store);
        await panel.__receive({ type: 'ready' });
        const snapshot = latest_snapshot(panel);

        await panel.__receive({
            type: 'setTransform',
            sheetIndex: 0,
            requestId: 'sort-before-edit',
            generation: snapshot.generation,
            sourceGeneration: snapshot.sourceGeneration,
            intent: 'user',
            state: {
                sort: [{ colIndex: 0, direction: 'asc' }],
                filters: [],
                schema: '["Sheet1",1,["h"]]',
            },
        });
        const applied = basis_of(transform_installs(panel).find((message) => (
            message.requestId === 'sort-before-edit'
        ))!);

        function displayed_rows(request_id: string, generation: number) {
            return panel.__receive({
                type: 'requestRows', sheetIndex: 0, startRow: 0, count: 3,
                requestId: request_id, generation,
            }).then(() => {
                const rows = panel.__messages.find((message: any) => (
                    message?.type === 'rowData' && message.requestId === request_id
                )) as { rows: Array<Array<{ raw: string }>> };
                return rows.rows.map((row) => row[0].raw);
            });
        }

        const before = await displayed_rows('sorted-before-edit', applied.generation);
        expect(before).toEqual(['a', 'b', 'c']);

        await panel.__receive({ type: 'requestEditSession' } as never);
        expect(edit_session_results(panel)).toEqual([
            { type: 'editSessionResult', granted: true },
        ]);
        // `denied_by_transform` must not fire on an installed transform: nothing
        // was denied, so the user gets no warning telling them to wait or clear.
        expect(warning).not.toHaveBeenCalled();

        // Same generation, same order: nothing moved on the way in, and the sort
        // is still installed rather than having been cleared to permit editing.
        const after = await displayed_rows('sorted-after-edit', applied.generation);
        expect(after).toEqual(before);
        expect(shared.get_state(file_path).transforms?.[0]?.sort).toEqual([
            { colIndex: 0, direction: 'asc' },
        ]);
        expect(latest_snapshot(panel).capabilities.csvEditable).toBe(true);
    });

    it('projects cached edits on reopen when durable state also holds an active transform', async () => {
        // Reachable only since transforms are admitted during an owned session: the
        // owner edits, sorts, and closes the tab, so durable state legitimately
        // carries both pendingEdits and an active transform. If the reclaim were
        // refused on the *installed* transform, `project_state_for_panel` would
        // strip pendingEdits and the viewer would open looking clean, with the
        // user's cached work invisible.
        const file_path = '/tmp/durable-edits-under-transform.csv';
        const pendingEdits = { '0:0': { value: 'cached-edit', base: 'c' } };
        const shared = state_store({
            pendingEdits,
            transforms: [{
                sort: [{ colIndex: 0, direction: 'asc' }],
                filters: [],
                schema: '["Sheet1",1,["h"]]',
            }],
        });
        const bytes = enc.encode('h\nc\na\nb\n');
        vscode_mock.__setStatImplementation(async () => ({
            size: bytes.byteLength, mtime: 1,
        }));
        vscode_mock.__setReadFileImplementation(async () => bytes);
        const reopened = open_csv_table(uri(file_path), shared.store);
        await reopened.__receive({ type: 'ready' });

        const snapshot = latest_snapshot(reopened);
        expect(snapshot.state.pendingEdits).toEqual(pendingEdits);
        expect(snapshot.capabilities.csvEditable).toBe(true);
        expect(snapshot.capabilities.csvEditSessionId).toBeDefined();
    });

    it('counts the reopened edits a restored filter hides, and none once it is cleared', async () => {
        // The case the count exists for. The user edited rows and closed the tab; the
        // filter is recomputed on reopen from *saved* values, so rows holding those
        // edits are simply absent and the work is unreachable in the grid. Nothing in
        // the webview can see that — membership never crosses the protocol — so the
        // number has to arrive on the install record.
        const file_path = '/tmp/hidden-edited-cells-on-reopen.csv';
        const filter = {
            sort: [],
            filters: [{
                id: 'keep-a',
                colIndex: 0,
                operator: 'equals' as const,
                value: 'a',
                caseSensitive: false,
                enabled: true,
            }],
            schema: '["Sheet1",1,["h"]]',
        };
        const shared = state_store({
            // Source rows are c, a, b. Row 0 carries two edited cells and row 2 one;
            // row 1 is the only row the filter keeps, so its edit stays visible.
            pendingEdits: {
                '0:0': { value: 'edited-c', base: 'c' },
                '0:1': { value: 'new-column', base: '' },
                '1:0': { value: 'edited-a', base: 'a' },
                '2:0': { value: 'edited-b', base: 'b' },
            },
            transforms: [filter],
        });
        const bytes = enc.encode('h\nc\na\nb\n');
        vscode_mock.__setStatImplementation(async () => ({
            size: bytes.byteLength, mtime: 1,
        }));
        vscode_mock.__setReadFileImplementation(async () => bytes);
        const reopened = open_csv_table(uri(file_path), shared.store);
        await reopened.__receive({ type: 'ready' });
        const snapshot = latest_snapshot(reopened);
        // The precondition: the panel holds the session, so these edits are its work
        // to report on. Without this the count would be about nobody's session.
        expect(snapshot.capabilities.csvEditSessionId).toBeDefined();

        await reopened.__receive({
            type: 'setTransform',
            sheetIndex: 0,
            requestId: 'restore-hiding-filter',
            generation: snapshot.generation,
            sourceGeneration: snapshot.sourceGeneration,
            intent: 'restore',
            state: filter,
        });

        const restored = transform_installs(reopened).at(-1)!;
        expect(restored.view.rowCount).toBe(1);
        expect([...restored.view.hiddenEditedCellKeys].sort())
            .toEqual(['0:0', '0:1', '2:0']);

        // Clearing the filter puts every row back, so the same edits are visible and
        // the set has to fall to empty rather than latch.
        await reopened.__receive({
            type: 'setTransform',
            sheetIndex: 0,
            requestId: 'clear-hiding-filter',
            generation: restored.view.basis.generation,
            sourceGeneration: restored.view.basis.sourceGeneration,
            intent: 'user',
            state: { sort: [], filters: [] },
        });

        const cleared = transform_installs(reopened).at(-1)!;
        expect(cleared.requestId).toBe('clear-hiding-filter');
        expect(cleared.view.rowCount).toBe(3);
        expect(cleared.view.hiddenEditedCellKeys).toEqual([]);
    });

    it('counts an edit made in this session once a filter is installed over it', async () => {
        // The live half of the same fact, and the proof that the durable map is read
        // rather than a start-of-session copy: the edit is typed, persisted, and only
        // then does a filter the *saved* value fails take its row out of the view.
        const file_path = '/tmp/hidden-edited-cells-after-typing.csv';
        const shared = state_store();
        const bytes = enc.encode('h\nc\na\nb\n');
        vscode_mock.__setStatImplementation(async () => ({
            size: bytes.byteLength, mtime: 1,
        }));
        vscode_mock.__setReadFileImplementation(async () => bytes);
        const panel = open_csv_table(uri(file_path), shared.store);
        await panel.__receive({ type: 'ready' });
        await panel.__receive({ type: 'requestEditSession' } as never);
        const session_id = latest_edit_session_message(panel)!.editSessionId!;
        await panel.__receive({
            type: 'pendingEditsChanged',
            editSessionId: session_id,
            edits: { '2:0': { value: 'edited-b', base: 'b' } },
        });
        expect(shared.get_state(file_path).pendingEdits).toEqual({
            '2:0': { value: 'edited-b', base: 'b' },
        });

        const snapshot = latest_snapshot(panel);
        await panel.__receive({
            type: 'setTransform',
            sheetIndex: 0,
            requestId: 'filter-over-live-edit',
            generation: snapshot.generation,
            sourceGeneration: snapshot.sourceGeneration,
            intent: 'user',
            state: {
                sort: [],
                filters: [{
                    id: 'keep-a',
                    colIndex: 0,
                    operator: 'equals',
                    value: 'a',
                    caseSensitive: false,
                    enabled: true,
                }],
                schema: '["Sheet1",1,["h"]]',
            },
        });

        const installed = transform_installs(panel).at(-1)!;
        expect(installed.requestId).toBe('filter-over-live-edit');
        expect(installed.view.hiddenEditedCellKeys).toEqual(['2:0']);
    });

    it('does not count another session\'s tombstoned edits as hidden work', async () => {
        // The count reports what *this* session is holding, which is why it reads
        // through pending_edits_for_current_session rather than the durable map.
        //
        // Reaching the window takes work, and that is the point: the ordinary route
        // awaits `ensure_failed_save_cleanup` before granting the next session, so the
        // failed operation's entries are normally gone from durable state by the time
        // any install can see them. Here the cleanup *write* keeps failing, so the
        // next session runs with the tombstone still standing over entries still on
        // disk — the one shape where the durable map and this session's work differ.
        // The projection already strips them, so counting them would put a number in
        // the banner naming cells the grid does not hold.
        const file_path = '/tmp/hidden-edited-cells-ignores-tombstone.csv';
        const versioned = state_store();
        let cleanup_writes = 0;
        const store: FileStateStore = {
            ...versioned.store,
            async compare_and_set(path, expected, next, validate) {
                const current = await versioned.store.read(path);
                if ((current.state as PerFileState).pendingEdits && !next.pendingEdits) {
                    cleanup_writes += 1;
                    throw new Error('cleanup write failed');
                }
                return versioned.store.compare_and_set(path, expected, next, validate);
            },
        };
        const bytes = enc.encode('h\nc\na\nb\n');
        vscode_mock.__setStatImplementation(async () => ({
            size: bytes.byteLength, mtime: 1,
        }));
        vscode_mock.__setReadFileImplementation(async () => bytes);
        vscode_mock.__setWriteFileImplementation(async () => {
            throw new Error('disk write failed');
        });
        const error = vi.spyOn(console, 'error').mockImplementation(() => {});
        const panel = open_csv_table(uri(file_path), store);
        await panel.__receive({ type: 'ready' });
        await panel.__receive({ type: 'requestEditSession', requestId: 'session-a' });
        const session_a = latest_edit_session_message(panel)!.editSessionId!;
        const dirtyEdits = { '2:0': { value: 'edited-b', base: 'b' } };
        await panel.__receive({
            type: 'pendingEditsChanged',
            editSessionId: session_a,
            edits: dirtyEdits,
        });
        await panel.__receive({
            type: 'saveCsv',
            operation: {
                editSessionId: session_a,
                saveRequestId: 'failing-save',
                edits: { '2:0': 'edited-b' },
                dirtyEdits,
            },
        });
        await panel.__receive({ type: 'releaseEditSession', editSessionId: session_a });
        await panel.__receive({ type: 'requestEditSession', requestId: 'session-b' });
        const session_b = latest_edit_session_message(panel)!.editSessionId!;
        await flush_promises();

        // The preconditions, asserted rather than assumed: a different session, the
        // failed operation's entries still durable, and a cleanup that has actually
        // been attempted and refused.
        expect(session_b).not.toBe(session_a);
        expect(session_b).toBeDefined();
        expect(cleanup_writes).toBeGreaterThan(0);
        expect(versioned.get_state(file_path).pendingEdits).toEqual(dirtyEdits);

        const snapshot = latest_snapshot(panel);
        await panel.__receive({
            type: 'setTransform',
            sheetIndex: 0,
            requestId: 'filter-over-tombstone',
            generation: snapshot.generation,
            sourceGeneration: snapshot.sourceGeneration,
            intent: 'user',
            state: {
                sort: [],
                filters: [{
                    id: 'keep-a',
                    colIndex: 0,
                    operator: 'equals',
                    value: 'a',
                    caseSensitive: false,
                    enabled: true,
                }],
                schema: '["Sheet1",1,["h"]]',
            },
        });

        const installed = transform_installs(panel).at(-1)!;
        expect(installed.requestId).toBe('filter-over-tombstone');
        // Source row 2 is exactly the row the filter drops, so an unscoped read of the
        // durable map would name its cell here.
        expect(installed.view.rowCount).toBe(1);
        expect(installed.view.hiddenEditedCellKeys).toEqual([]);
        error.mockRestore();
    });

    it('projects cached edits on reopen while a sibling transform is still computing', async () => {
        // `may_rehydrate_session()` is the one transform-shaped question whose answer
        // is unconditionally yes, and this is the case that distinguishes it from
        // `may_begin_editing()`: the same in-flight work that refuses a *fresh* entry
        // into edit mode must not refuse a reopened panel the session its durable
        // edits already describe. Nothing is being started here — the session exists
        // in durable state — so a refusal would not serialize anything, it would just
        // strip the user's unsaved work out of the projection.
        const file_path = '/tmp/rehydrate-during-transform-compute.csv';
        const shared = state_store();
        const bytes = enc.encode('h\nc\na\nb\n');
        vscode_mock.__setStatImplementation(async () => ({
            size: bytes.byteLength, mtime: 1,
        }));
        vscode_mock.__setReadFileImplementation(async () => bytes);
        const owner = open_csv_table(uri(file_path), shared.store);
        await owner.__receive({ type: 'ready' });
        await owner.__receive({ type: 'requestEditSession' } as never);
        const session_id = latest_edit_session_message(owner)!.editSessionId!;
        const pendingEdits = { '0:0': { value: 'cached-edit', base: 'c' } };
        await owner.__receive({
            type: 'pendingEditsChanged',
            editSessionId: session_id,
            edits: pendingEdits,
        });
        await owner.__receive({ type: 'releaseEditSession', editSessionId: session_id });
        // The precondition: durable work with no panel holding the session, which is
        // what a closed tab leaves behind.
        expect(shared.get_state(file_path).pendingEdits).toEqual(pendingEdits);

        const owner_snapshot = latest_snapshot(owner);
        const transform = owner.__receive({
            type: 'setTransform',
            sheetIndex: 0,
            requestId: 'computing-during-reopen',
            generation: owner_snapshot.generation,
            sourceGeneration: owner_snapshot.sourceGeneration,
            intent: 'user',
            state: {
                sort: [{ colIndex: 0, direction: 'asc' }],
                filters: [],
                schema: '["Sheet1",1,["h"]]',
            },
        });
        // `compute_transform` yields on `setImmediate`, so awaiting microtasks below
        // cannot let it land. Asserted rather than assumed: without this the test
        // would silently become the already-covered installed-transform case.
        expect(transform_answers(owner)).toEqual([]);

        const reopened = open_csv_table(uri(file_path), shared.store);
        await reopened.__receive({ type: 'ready' });
        expect(transform_answers(owner)).toEqual([]);

        const snapshot = latest_snapshot(reopened);
        expect(snapshot.state.pendingEdits).toEqual(pendingEdits);
        expect(snapshot.capabilities.csvEditSessionId).toBeDefined();

        await transform;
    });

    it('never moves a rehydrated owner\'s rows for a sibling transform admitted before the reopen', async () => {
        // The race `may_rehydrate_session()` answering yes unconditionally opens, and
        // the reason the admission question is asked a second time at the commit.
        // The sibling's transform was admitted from a `free` phase, so nothing was
        // wrong when it started; while it computes, a reopened panel takes the
        // session its durable pending edits describe. Admission has lapsed — the
        // phase is now `owned` by a panel that is not the requester — but the
        // currency guard cannot tell, because no receiver epoch, source authority or
        // generation moved. Persisting anyway would put the rules where the reopened
        // owner's restore effect reads them, and its rows would move mid-session.
        const file_path = '/tmp/sibling-transform-commit-after-rehydrate.csv';
        const versioned = state_store();
        const commit_read_started = deferred();
        const commit_read_gate = deferred();
        let gate_commit_read = false;
        const store: FileStateStore = {
            ...versioned.store,
            async read(path) {
                // One-shot, armed immediately before the transform is posted: the
                // only state read between arming and the commit is the commit's own,
                // because admission and `compute_transform` touch no durable state.
                // This parks the sibling exactly where the finding lives — admitted,
                // computed, one CAS short of durable.
                if (gate_commit_read) {
                    gate_commit_read = false;
                    commit_read_started.resolve();
                    await commit_read_gate.promise;
                }
                return versioned.store.read(path);
            },
        };
        const bytes = enc.encode('h\nc\na\nb\n');
        vscode_mock.__setStatImplementation(async () => ({
            size: bytes.byteLength, mtime: 1,
        }));
        vscode_mock.__setReadFileImplementation(async () => bytes);
        const sibling = open_csv_table(uri(file_path), store);
        await sibling.__receive({ type: 'ready' });
        await sibling.__receive({ type: 'requestEditSession' } as never);
        const session_id = latest_edit_session_message(sibling)!.editSessionId!;
        const pendingEdits = { '0:0': { value: 'cached-edit', base: 'c' } };
        await sibling.__receive({
            type: 'pendingEditsChanged',
            editSessionId: session_id,
            edits: pendingEdits,
        });
        await sibling.__receive({ type: 'releaseEditSession', editSessionId: session_id });
        // The precondition: durable work, phase free, so the transform below is
        // admitted for a legitimate reason and the reopen below can claim.
        expect(versioned.get_state(file_path).pendingEdits).toEqual(pendingEdits);

        const sibling_snapshot = latest_snapshot(sibling);
        gate_commit_read = true;
        const transform = sibling.__receive({
            type: 'setTransform',
            sheetIndex: 0,
            requestId: 'admitted-then-lapsed',
            generation: sibling_snapshot.generation,
            sourceGeneration: sibling_snapshot.sourceGeneration,
            intent: 'user',
            state: {
                sort: [{ colIndex: 0, direction: 'asc' }],
                filters: [],
                schema: '["Sheet1",1,["h"]]',
            },
        });
        await commit_read_started.promise;
        // Deterministic, not timing-dependent: the transform is provably past
        // admission and past compute, and provably has not written anything.
        expect(transform_answers(sibling)).toEqual([]);
        expect(versioned.get_state(file_path).transforms?.[0]).toBeUndefined();

        const reopened = open_csv_table(uri(file_path), store);
        await reopened.__receive({ type: 'ready' });
        const rehydrated = latest_snapshot(reopened);
        // The reopen really did rehydrate — the whole point of the unconditional
        // answer — so the phase the sibling was admitted under is gone.
        expect(rehydrated.state.pendingEdits).toEqual(pendingEdits);
        expect(rehydrated.capabilities.csvEditSessionId).toBeDefined();
        const natural = await reopened.__receive({
            type: 'requestRows', sheetIndex: 0, startRow: 0, count: 3,
            requestId: 'before-sibling-commit', generation: rehydrated.generation,
        }).then(() => (reopened.__messages.find((message: any) => (
            message?.type === 'rowData' && message.requestId === 'before-sibling-commit'
        )) as { rows: Array<Array<{ raw: string }>> }).rows.map((row) => row[0].raw));
        expect(natural).toEqual(['c', 'a', 'b']);

        commit_read_gate.resolve();
        await transform;
        await flush_promises();

        // The finding: the sibling's rules must not become durable, because durable
        // is how they would reach the panel that now owns editing.
        expect(versioned.get_state(file_path).transforms?.[0]).toBeUndefined();
        // Refused with the admission's own reason rather than a currency error, so
        // the sibling's toolbar tells the user something true.
        expect(transform_answers(sibling)).toEqual([expect.objectContaining({
            type: 'transformRefused',
            requestId: 'admitted-then-lapsed',
            reason: 'Another panel is editing this file.',
        })]);

        // The load-bearing half, and it needs the owner to *touch* durable state to
        // be worth anything: a transform commit does not notify siblings, so the
        // rules would reach this panel on its next read. Typing another cell is that
        // read — `update_edit_session_state` re-reads and notifies every subscriber,
        // which reprojects durable state into this panel's snapshot, and the
        // webview's restore effect installs whatever rules that snapshot describes.
        // That is the row movement, mid-session, on the ordinary act of editing.
        // The projected `transforms` is the assertion that carries it: the install
        // itself happens in the webview, so the three host-side checks after it
        // document the guarantee without being able to prove it alone.
        await reopened.__receive({
            type: 'pendingEditsChanged',
            editSessionId: rehydrated.capabilities.csvEditSessionId!,
            edits: { ...pendingEdits, '1:0': { value: 'typed-during', base: 'a' } },
        });
        expect(latest_snapshot(reopened).state.transforms?.[0]).toBeUndefined();
        expect(transform_answers(reopened)).toEqual([]);
        expect(latest_snapshot(reopened).generation).toBe(rehydrated.generation);
        const after = await reopened.__receive({
            type: 'requestRows', sheetIndex: 0, startRow: 0, count: 3,
            requestId: 'after-sibling-commit', generation: rehydrated.generation,
        }).then(() => (reopened.__messages.find((message: any) => (
            message?.type === 'rowData' && message.requestId === 'after-sibling-commit'
        )) as { rows: Array<Array<{ raw: string }>> }).rows.map((row) => row[0].raw));
        expect(after).toEqual(natural);
        expect(latest_snapshot(reopened).state.pendingEdits).toMatchObject(pendingEdits);
    });

    it('declines a sibling transform whose admission lapses inside the commit CAS', async () => {
        // The same finding one window narrower, and the reason the admission term
        // lives in the predicate the CAS calls as `validate` rather than only in the
        // mutator. Here the transform is parked *inside* `compare_and_set`, so it has
        // already passed every pre-write check under a `free` phase; the reopen
        // rehydrates while it sits there. A guard evaluated only before the write
        // would let these rules land, and the finding would be narrowed instead of
        // closed.
        const file_path = '/tmp/sibling-transform-cas-after-rehydrate.csv';
        const versioned = state_store();
        const cas_started = deferred();
        const cas_gate = deferred();
        let gate_transform_cas = false;
        const store: FileStateStore = {
            ...versioned.store,
            async compare_and_set(path, expected, next, validate) {
                if (gate_transform_cas && next.transforms?.[0]) {
                    gate_transform_cas = false;
                    cas_started.resolve();
                    await cas_gate.promise;
                }
                return versioned.store.compare_and_set(path, expected, next, validate);
            },
        };
        const bytes = enc.encode('h\nc\na\nb\n');
        vscode_mock.__setStatImplementation(async () => ({
            size: bytes.byteLength, mtime: 1,
        }));
        vscode_mock.__setReadFileImplementation(async () => bytes);
        const sibling = open_csv_table(uri(file_path), store);
        await sibling.__receive({ type: 'ready' });
        await sibling.__receive({ type: 'requestEditSession' } as never);
        const session_id = latest_edit_session_message(sibling)!.editSessionId!;
        const pendingEdits = { '0:0': { value: 'cached-edit', base: 'c' } };
        await sibling.__receive({
            type: 'pendingEditsChanged',
            editSessionId: session_id,
            edits: pendingEdits,
        });
        await sibling.__receive({ type: 'releaseEditSession', editSessionId: session_id });
        expect(versioned.get_state(file_path).pendingEdits).toEqual(pendingEdits);

        const sibling_snapshot = latest_snapshot(sibling);
        gate_transform_cas = true;
        const transform = sibling.__receive({
            type: 'setTransform',
            sheetIndex: 0,
            requestId: 'lapsed-inside-cas',
            generation: sibling_snapshot.generation,
            sourceGeneration: sibling_snapshot.sourceGeneration,
            intent: 'user',
            state: {
                sort: [{ colIndex: 0, direction: 'asc' }],
                filters: [],
                schema: '["Sheet1",1,["h"]]',
            },
        });
        await cas_started.promise;
        // Every check the write passes before this point passed, and nothing is
        // durable yet: the write is mid-flight, not merely pending.
        expect(versioned.get_state(file_path).transforms?.[0]).toBeUndefined();

        const reopened = open_csv_table(uri(file_path), store);
        await reopened.__receive({ type: 'ready' });
        const rehydrated = latest_snapshot(reopened);
        expect(rehydrated.state.pendingEdits).toEqual(pendingEdits);
        expect(rehydrated.capabilities.csvEditSessionId).toBeDefined();

        cas_gate.resolve();
        await transform;
        await flush_promises();

        expect(versioned.get_state(file_path).transforms?.[0]).toBeUndefined();
        expect(transform_answers(sibling)).toEqual([expect.objectContaining({
            type: 'transformRefused',
            requestId: 'lapsed-inside-cas',
        })]);
        await reopened.__receive({
            type: 'pendingEditsChanged',
            editSessionId: rehydrated.capabilities.csvEditSessionId!,
            edits: { ...pendingEdits, '1:0': { value: 'typed-during', base: 'a' } },
        });
        expect(latest_snapshot(reopened).state.transforms?.[0]).toBeUndefined();
    });

    it('persists the owning panel\'s own transform requested during its own session', async () => {
        // The paired direction, and the reason the guard is `admit_transform_for_phase`
        // rather than a blanket refusal at the commit: without this, declining every
        // commit would satisfy the test above while destroying the feature this PR
        // exists to add. The owner sorting the panel they are editing is the user
        // changing their own view, and it has to survive the reopen the rules are
        // written for.
        const file_path = '/tmp/owner-own-transform-commit.csv';
        const shared = state_store();
        const bytes = enc.encode('h\nc\na\nb\n');
        vscode_mock.__setStatImplementation(async () => ({
            size: bytes.byteLength, mtime: 1,
        }));
        vscode_mock.__setReadFileImplementation(async () => bytes);
        const owner = open_csv_table(uri(file_path), shared.store);
        await owner.__receive({ type: 'ready' });
        await owner.__receive({ type: 'requestEditSession' } as never);
        expect(latest_edit_session_message(owner)).toMatchObject({ granted: true });
        const snapshot = latest_snapshot(owner);

        await owner.__receive({
            type: 'setTransform',
            sheetIndex: 0,
            requestId: 'owner-own-sort',
            generation: snapshot.generation,
            sourceGeneration: snapshot.sourceGeneration,
            intent: 'user',
            state: {
                sort: [{ colIndex: 0, direction: 'asc' }],
                filters: [],
                schema: '["Sheet1",1,["h"]]',
            },
        });

        expect(transform_answers(owner)).toEqual([expect.objectContaining({
            type: 'transformInstalled',
            requestId: 'owner-own-sort',
        })]);
        expect(shared.get_state(file_path).transforms?.[0]?.sort).toEqual([
            { colIndex: 0, direction: 'asc' },
        ]);
    });

    it('persists a transform committed with no edit session anywhere', async () => {
        // The unconditioned case: nothing to serialize against, so the commit
        // boundary must be invisible. Pinned because the guard reads a *shared* edit
        // record that may not exist at all, and a refusal derived from its absence
        // would break sorting for every file nobody is editing.
        const file_path = '/tmp/no-session-transform-commit.csv';
        const shared = state_store();
        const bytes = enc.encode('h\nc\na\nb\n');
        vscode_mock.__setStatImplementation(async () => ({
            size: bytes.byteLength, mtime: 1,
        }));
        vscode_mock.__setReadFileImplementation(async () => bytes);
        const panel = open_csv_table(uri(file_path), shared.store);
        await panel.__receive({ type: 'ready' });
        const snapshot = latest_snapshot(panel);
        expect(snapshot.capabilities.csvEditSessionId).toBeUndefined();

        await panel.__receive({
            type: 'setTransform',
            sheetIndex: 0,
            requestId: 'unowned-sort',
            generation: snapshot.generation,
            sourceGeneration: snapshot.sourceGeneration,
            intent: 'user',
            state: {
                sort: [{ colIndex: 0, direction: 'asc' }],
                filters: [],
                schema: '["Sheet1",1,["h"]]',
            },
        });

        expect(transform_answers(panel)).toEqual([expect.objectContaining({
            type: 'transformInstalled',
            requestId: 'unowned-sort',
        })]);
        expect(shared.get_state(file_path).transforms?.[0]?.sort).toEqual([
            { colIndex: 0, direction: 'asc' },
        ]);
    });

    it('refuses to rehydrate a session another panel is still releasing', async () => {
        // The other half of the same split: `may_rehydrate_session()` answering yes
        // must not have loosened the claim serialization underneath it. A phase this
        // panel does not hold is still not this panel's to take, and the durable
        // edits stay with the panel that is finishing with them — the one drop
        // `project_state_for_panel` is allowed to make.
        const file_path = '/tmp/rehydrate-during-release.csv';
        const committed = { '0:0': { value: 'committed-draft', base: 'c' } };
        const versioned = state_store({ pendingEdits: committed });
        const compare_started = deferred();
        const compare_gate = deferred();
        const store: FileStateStore = {
            ...versioned.store,
            async compare_and_set(path, expected, next, validate) {
                if (next.pendingEdits?.['0:1']) {
                    compare_started.resolve();
                    await compare_gate.promise;
                }
                return versioned.store.compare_and_set(path, expected, next, validate);
            },
        };
        const bytes = enc.encode('h,i\nc,c\na,a\nb,b\n');
        vscode_mock.__setStatImplementation(async () => ({
            size: bytes.byteLength, mtime: 1,
        }));
        vscode_mock.__setReadFileImplementation(async () => bytes);
        const console_error = vi.spyOn(console, 'error').mockImplementation(() => {});
        const owner = open_csv_table(uri(file_path), store);
        await owner.__receive({ type: 'ready' });
        const session_id = latest_snapshot(owner).capabilities.csvEditSessionId!;
        expect(session_id).toBeDefined();

        // A second update whose write is gated, so the release below has something to
        // drain and the phase sits at `releasing` while the reopen happens. Durable
        // state still holds the first update throughout.
        const pending = owner.__receive({
            type: 'pendingEditsChanged',
            editSessionId: session_id,
            edits: { ...committed, '0:1': { value: 'later-draft', base: 'c' } },
        });
        await compare_started.promise;
        const release = owner.__receive({
            type: 'releaseEditSession',
            editSessionId: session_id,
        });

        const reopened = open_csv_table(uri(file_path), store);
        await reopened.__receive({ type: 'ready' });
        const blocked = latest_snapshot(reopened);
        expect(blocked.state.pendingEdits).toBeUndefined();
        expect(blocked.capabilities.csvEditSessionId).toBeUndefined();
        // Dropped for the one legitimate reason, so the loss assertion in
        // `project_state_for_panel` must stay quiet.
        expect(console_error.mock.calls.map((call) => call[0])).not.toContain(
            'Dropped durable CSV pending edits with no panel holding the session',
        );

        compare_gate.resolve();
        await Promise.all([pending, release]);
        console_error.mockRestore();

        // And nothing was lost by refusing: once the release finishes, the reopened
        // panel gets the whole durable set.
        await reopened.__receive({ type: 'requestEditSession' } as never);
        expect(latest_edit_session_message(reopened)).toMatchObject({
            granted: true,
            pendingEdits: { ...committed, '0:1': { value: 'later-draft', base: 'c' } },
        });
    });

    it('withholds the edit capability from a panel opened while a transform computes', async () => {
        // The in-flight half of `may_retain_capability()` on its non-owner path, which
        // is a statement about the *affordance* rather than about the claim: a panel
        // told `csvEditable` inside a window where the request would be refused shows
        // an edit control that cannot work, and stamps a blocker epoch that never
        // moves. Pinned through a panel's first adoption, because that is where
        // capabilities are projected live — a repeat `ready` replays the retained
        // projection and would make this assertion vacuous.
        const file_path = '/tmp/capability-during-transform-compute.csv';
        const shared = state_store();
        const bytes = enc.encode('h\nc\na\nb\n');
        vscode_mock.__setStatImplementation(async () => ({
            size: bytes.byteLength, mtime: 1,
        }));
        vscode_mock.__setReadFileImplementation(async () => bytes);
        const transformer = open_csv_table(uri(file_path), shared.store);
        await transformer.__receive({ type: 'ready' });
        const snapshot = latest_snapshot(transformer);

        const transform = transformer.__receive({
            type: 'setTransform',
            sheetIndex: 0,
            requestId: 'in-flight-capability',
            generation: snapshot.generation,
            sourceGeneration: snapshot.sourceGeneration,
            intent: 'user',
            state: {
                sort: [{ colIndex: 0, direction: 'asc' }],
                filters: [],
                schema: '["Sheet1",1,["h"]]',
            },
        });
        expect(transform_answers(transformer)).toEqual([]);

        const during = open_csv_table(uri(file_path), shared.store);
        await during.__receive({ type: 'ready' });
        expect(transform_answers(transformer)).toEqual([]);
        expect(latest_snapshot(during).capabilities.csvEditable).toBe(false);

        await transform;
        expect(transform_installs(transformer)).toHaveLength(1);

        // And the refusal really was the window, not the installed sort: a panel
        // opened after it lands is editable under the permutation.
        const after = open_csv_table(uri(file_path), shared.store);
        await after.__receive({ type: 'ready' });
        expect(latest_snapshot(after).capabilities.csvEditable).toBe(true);
    });

    it('makes a sibling editable again when the owner releasing it left a sort installed', async () => {
        // The sibling's `csvEditable` is the only signal its webview has that a
        // refusing condition moved; it stamps each refused transform restore with a
        // count of those movements. While an installed transform held this false,
        // releasing the session bumped nothing, so a sibling whose restore was
        // refused mid-session stayed stale under a toolbar showing the new rules.
        const file_path = '/tmp/sibling-editable-after-release.csv';
        const shared = state_store();
        const bytes = enc.encode('h\nc\na\nb\n');
        vscode_mock.__setStatImplementation(async () => ({
            size: bytes.byteLength, mtime: 1,
        }));
        vscode_mock.__setReadFileImplementation(async () => bytes);
        const owner = open_csv_table(uri(file_path), shared.store);
        const sibling = open_csv_table(uri(file_path), shared.store);
        await owner.__receive({ type: 'ready' });
        await sibling.__receive({ type: 'ready' });
        await owner.__receive({ type: 'requestEditSession' } as never);
        const edit_session_id = latest_edit_session_message(owner)!.editSessionId!;
        const owner_snapshot = latest_snapshot(owner);

        await owner.__receive({
            type: 'setTransform',
            sheetIndex: 0,
            requestId: 'owner-sort-durable',
            generation: owner_snapshot.generation,
            sourceGeneration: owner_snapshot.sourceGeneration,
            intent: 'user',
            state: {
                sort: [{ colIndex: 0, direction: 'asc' }],
                filters: [],
                schema: '["Sheet1",1,["h"]]',
            },
        });
        expect(shared.get_state(file_path).transforms?.[0]?.sort).toEqual([
            { colIndex: 0, direction: 'asc' },
        ]);
        await flush_promises();
        // The sibling is refused while the owner holds the session, which is what
        // makes its restore request get refused in the first place.
        expect(latest_snapshot(sibling).capabilities.csvEditable).toBe(false);
        sibling.__messages.length = 0;

        await owner.__receive({ type: 'releaseEditSession', editSessionId: edit_session_id });
        await flush_promises();

        await vi.waitUntil(() => [...sibling.__messages].reverse().some((message: any) => (
            message?.type === 'workbookSnapshot'
            && message.snapshot.capabilities.csvEditable === true
        )));
        // Still installed: releasing the session did not have to clear the sort for
        // the sibling to become editable again.
        expect(shared.get_state(file_path).transforms?.[0]?.sort).toEqual([
            { colIndex: 0, direction: 'asc' },
        ]);
    });

    it('refuses a save while a transform is in flight, then accepts it once the transform lands', async () => {
        // The mirror of `save_blocks_transform`. Without it the owner can start a
        // slow sort and save immediately: the save refreshes and replaces the
        // source, cancelling the transform, and the webview clears its request on
        // the row-basis change with no ack — the sort silently lost.
        const file_path = '/tmp/save-during-transform.csv';
        const shared = state_store();
        let bytes = enc.encode('h\nc\na\nb\n');
        vscode_mock.__setStatImplementation(async () => ({
            size: bytes.byteLength, mtime: 1,
        }));
        vscode_mock.__setReadFileImplementation(async () => bytes);
        vscode_mock.__setWriteFileImplementation(async (_uri, content) => {
            bytes = new Uint8Array(content);
        });
        const owner = open_csv_table(uri(file_path), shared.store);
        await owner.__receive({ type: 'ready' });
        await owner.__receive({ type: 'requestEditSession' } as never);
        const edit_session_id = latest_edit_session_message(owner)!.editSessionId!;
        const snapshot = latest_snapshot(owner);

        const transform = owner.__receive({
            type: 'setTransform',
            sheetIndex: 0,
            requestId: 'sort-during-save-attempt',
            generation: snapshot.generation,
            sourceGeneration: snapshot.sourceGeneration,
            intent: 'user',
            state: {
                sort: [{ colIndex: 0, direction: 'asc' }],
                filters: [],
                schema: '["Sheet1",1,["h"]]',
            },
        });
        await owner.__receive({
            type: 'saveCsv',
            operation: {
                editSessionId: edit_session_id,
                saveRequestId: 'save-during-transform',
                edits: { '0:0': 'edited-c' },
                dirtyEdits: { '0:0': { value: 'edited-c', base: 'c' } },
            },
        });
        await flush_promises();
        expect(owner.__messages).toContainEqual(expect.objectContaining({
            type: 'saveResult', success: false,
        }));
        expect(owner.__messages).not.toContainEqual(expect.objectContaining({
            type: 'saveResult', success: true,
        }));
        expect(new TextDecoder().decode(bytes)).toBe('h\nc\na\nb\n');

        // The transform the refused save would otherwise have cancelled still lands.
        await transform;
        expect(transform_answers(owner).find((message) => (
            message.requestId === 'sort-during-save-attempt'
        ))?.type).toBe('transformInstalled');
        expect(shared.get_state(file_path).transforms?.[0]?.sort).toEqual([
            { colIndex: 0, direction: 'asc' },
        ]);

        // Paired direction: the refusal is transient, so the same save now works —
        // and writes the source row the dirty key names, not the display row.
        await owner.__receive({
            type: 'saveCsv',
            operation: {
                editSessionId: edit_session_id,
                saveRequestId: 'save-after-transform',
                edits: { '0:0': 'edited-c' },
                dirtyEdits: { '0:0': { value: 'edited-c', base: 'c' } },
            },
        });
        await vi.waitFor(() => expect(owner.__messages).toContainEqual(
            expect.objectContaining({ type: 'saveResult', success: true }),
        ));
        expect(new TextDecoder().decode(bytes)).toBe('h\nedited-c\na\nb\n');
    });

    it('refuses a sibling sort, keeps ready natural, and saves the same physical row', async () => {
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
        expect(sibling.__messages).toContainEqual(expect.objectContaining({
            type: 'transformRefused',
            requestId: 'sort-while-owned',
            reason: 'Another panel is editing this file.',
        }));
        expect(shared.get_state(file_path).transforms).toBeUndefined();

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

    it('saves the same physical row after the owner itself installs a sort', async () => {
        // The valuable half: source-keyed edits (#110) must survive a transform the
        // owner installed. Display row 0 under an ascending sort is source row 1
        // ('a'), so a display-keyed save would corrupt the wrong line.
        const file_path = '/tmp/owner-transform-row-identity.csv';
        const shared = state_store();
        let bytes = enc.encode('h\nc\na\nb\n');
        vscode_mock.__setStatImplementation(async () => ({ size: bytes.byteLength, mtime: 1 }));
        vscode_mock.__setReadFileImplementation(async () => bytes);
        vscode_mock.__setWriteFileImplementation(async (_uri, content) => {
            bytes = new Uint8Array(content);
        });
        const owner = open_csv_table(uri(file_path), shared.store);
        await owner.__receive({ type: 'ready' });
        await owner.__receive({ type: 'requestEditSession' } as never);
        const edit_session_id = latest_edit_session_message(owner)!.editSessionId!;
        const snapshot = latest_snapshot(owner);

        await owner.__receive({
            type: 'setTransform',
            sheetIndex: 0,
            requestId: 'owner-sort-before-save',
            generation: snapshot.generation,
            sourceGeneration: snapshot.sourceGeneration,
            intent: 'user',
            state: {
                sort: [{ colIndex: 0, direction: 'asc' }],
                filters: [],
                schema: '["Sheet1",1,["h"]]',
            },
        });
        const applied = basis_of(transform_installs(owner).find((message) => (
            message.requestId === 'owner-sort-before-save'
        ))!);
        await owner.__receive({
            type: 'requestRows', sheetIndex: 0, startRow: 0, count: 3,
            requestId: 'owner-sorted-before-save', generation: applied.generation,
        });
        const rows = owner.__messages.find((message) => (
            typeof message === 'object'
            && message !== null
            && 'type' in message
            && message.type === 'rowData'
            && 'requestId' in message
            && message.requestId === 'owner-sorted-before-save'
        )) as { rows: Array<Array<{ raw: string }>> };
        expect(rows.rows.map((row) => row[0].raw)).toEqual(['a', 'b', 'c']);

        // Source row 0 ('c'), which the sort moved to display row 2.
        await owner.__receive({
            type: 'saveCsv',
            operation: {
                editSessionId: edit_session_id,
                saveRequestId: 'save-under-owner-sort',
                edits: { '0:0': 'edited-c' },
                dirtyEdits: { '0:0': { value: 'edited-c', base: 'c' } },
            },
        });
        await flush_promises();
        expect(owner.__messages).toContainEqual(expect.objectContaining({
            type: 'saveResult', success: true,
        }));
        expect(new TextDecoder().decode(bytes)).toBe('h\nedited-c\na\nb\n');
    });

    it('refuses a transform while a save is in flight, then admits one after it lands', async () => {
        // Host-enforced, not merely UI-disabled: a stale or injected webview message
        // reaches handle_transform_message directly. The second half is what proves
        // the refusal is transient rather than a new permanent barrier.
        const file_path = '/tmp/transform-during-save.csv';
        const shared = state_store();
        let bytes = enc.encode('h\nc\na\nb\n');
        const write_gate = deferred();
        vscode_mock.__setStatImplementation(async () => ({
            size: bytes.byteLength, mtime: 1,
        }));
        vscode_mock.__setReadFileImplementation(async () => bytes);
        vscode_mock.__setWriteFileImplementation(async (_uri, content) => {
            await write_gate.promise;
            bytes = new Uint8Array(content);
        });
        const owner = open_csv_table(uri(file_path), shared.store);
        await owner.__receive({ type: 'ready' });
        await owner.__receive({ type: 'requestEditSession' } as never);
        const edit_session_id = latest_edit_session_message(owner)!.editSessionId!;
        const before_save = latest_snapshot(owner);

        const save = owner.__receive({
            type: 'saveCsv',
            operation: {
                editSessionId: edit_session_id,
                saveRequestId: 'gated-save',
                edits: { '0:0': 'edited-c' },
                dirtyEdits: { '0:0': { value: 'edited-c', base: 'c' } },
            },
        });
        await vi.waitFor(() => expect(owner.__messages).toContainEqual(
            expect.objectContaining({ type: 'saveOperationStarted' }),
        ));

        await owner.__receive({
            type: 'setTransform',
            sheetIndex: 0,
            requestId: 'sort-during-save',
            generation: before_save.generation,
            sourceGeneration: before_save.sourceGeneration,
            intent: 'user',
            state: {
                sort: [{ colIndex: 0, direction: 'asc' }],
                filters: [],
                schema: '["Sheet1",1,["h"]]',
            },
        });
        expect(owner.__messages).toContainEqual(expect.objectContaining({
            type: 'transformRefused',
            requestId: 'sort-during-save',
            reason: 'Wait for the save to finish before sorting, filtering, or hiding rows.',
            // Non-terminal so the webview keeps the request and retries once the save
            // lands. There is no echoed state it could adopt in the meantime.
            terminal: false,
        }));
        // The save itself persists a sheet-shaped transforms array, so the
        // meaningful assertion is that the refused sort left no entry in it.
        expect(shared.get_state(file_path).transforms?.[0]).toBeUndefined();

        write_gate.resolve();
        await save;
        await vi.waitFor(() => expect(owner.__messages).toContainEqual(
            expect.objectContaining({ type: 'saveResult', success: true }),
        ));
        await flush_promises();

        const after_save = latest_snapshot(owner);
        await owner.__receive({
            type: 'setTransform',
            sheetIndex: 0,
            requestId: 'sort-after-save',
            generation: after_save.generation,
            sourceGeneration: after_save.sourceGeneration,
            intent: 'user',
            state: {
                sort: [{ colIndex: 0, direction: 'asc' }],
                filters: [],
                schema: '["Sheet1",1,["h"]]',
            },
        });
        expect(transform_answers(owner).find((message) => (
            message.requestId === 'sort-after-save'
        ))?.type).toBe('transformInstalled');
        expect(shared.get_state(file_path).transforms?.[0]?.sort).toEqual([
            { colIndex: 0, direction: 'asc' },
        ]);
    });

    it('refuses a transform while post-save pending-edit cleanup is still in flight', async () => {
        // cleanupPending: the CAS that clears durable pending edits has not
        // committed, so clearedStateRevision is unrecorded and a transform write
        // would race it.
        const file_path = '/tmp/transform-during-cleanup.csv';
        const versioned = state_store({
            pendingEdits: { '0:0': { value: 'edited-a', base: 'a' } },
        });
        const cleanup_started = deferred();
        const cleanup_gate = deferred();
        let bytes = enc.encode('h\na\nb\nc\n');
        vscode_mock.__setStatImplementation(async () => ({
            size: bytes.byteLength, mtime: 1,
        }));
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
        const owner = open_csv_table(uri(file_path), store);
        await owner.__receive({ type: 'ready' });
        await owner.__receive({ type: 'requestEditSession' } as never);
        const snapshot = latest_snapshot(owner);
        const save = owner.__receive({ type: 'saveCsv', edits: { '0:0': 'edited-a' } });
        await cleanup_started.promise;

        await owner.__receive({
            type: 'setTransform',
            sheetIndex: 0,
            requestId: 'sort-during-cleanup',
            generation: snapshot.generation,
            sourceGeneration: snapshot.sourceGeneration,
            intent: 'user',
            state: {
                sort: [{ colIndex: 0, direction: 'asc' }],
                filters: [],
                schema: '["Sheet1",1,["h"]]',
            },
        });
        expect(owner.__messages).toContainEqual(expect.objectContaining({
            type: 'transformRefused',
            requestId: 'sort-during-cleanup',
            reason: 'Finishing edit-session work; try again in a moment.',
        }));
        // The save wrote a sheet-shaped transforms array of its own, so the
        // meaningful assertion is that the refused sort left sheet 0 untouched.
        expect(versioned.get_state(file_path).transforms?.[0]).toBeUndefined();

        cleanup_gate.resolve();
        await save;
        await flush_promises();
    });

    it('refuses a transform while a release is still draining admitted edit writes', async () => {
        // releasing: release_edit_session is awaiting pending_edit_writes, so
        // durable pending edits may yet be written.
        const file_path = '/tmp/transform-during-release.csv';
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
        await owner.__receive({ type: 'ready' });
        await owner.__receive({ type: 'requestEditSession' } as never);
        const session_id = latest_edit_session_message(owner)!.editSessionId!;
        const snapshot = latest_snapshot(owner);

        const pending = owner.__receive({
            type: 'pendingEditsChanged',
            editSessionId: session_id,
            edits: { '0:0': { value: 'draining', base: 'c' } },
        });
        await compare_started.promise;
        const release = owner.__receive({
            type: 'releaseEditSession',
            editSessionId: session_id,
        });

        await owner.__receive({
            type: 'setTransform',
            sheetIndex: 0,
            requestId: 'sort-during-release',
            generation: snapshot.generation,
            sourceGeneration: snapshot.sourceGeneration,
            intent: 'user',
            state: {
                sort: [{ colIndex: 0, direction: 'asc' }],
                filters: [],
                schema: '["Sheet1",1,["h"]]',
            },
        });
        expect(owner.__messages).toContainEqual(expect.objectContaining({
            type: 'transformRefused',
            requestId: 'sort-during-release',
            reason: 'Finishing edit-session work; try again in a moment.',
        }));
        expect(versioned.get_state(file_path).transforms).toBeUndefined();

        compare_gate.resolve();
        await Promise.all([pending, release]);
        expect(versioned.get_state(file_path).pendingEdits).toEqual({
            '0:0': { value: 'draining', base: 'c' },
        });
    });

    it('refuses a transform while durable edit state is uncertain after a failed clear', async () => {
        // uncertain: the clear rejected, so durable pending-edit state may or may
        // not exist. Never admit under unknown durable state.
        const file_path = '/tmp/transform-during-uncertain.csv';
        const versioned = state_store({
            pendingEdits: { '0:0': { value: 'edited-a', base: 'a' } },
        });
        let bytes = enc.encode('h\na\nb\nc\n');
        vscode_mock.__setStatImplementation(async () => ({
            size: bytes.byteLength, mtime: 1,
        }));
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
        vi.spyOn(console, 'error').mockImplementation(() => {});
        const owner = open_csv_table(uri(file_path), store);
        await owner.__receive({ type: 'ready' });
        await owner.__receive({ type: 'requestEditSession' } as never);
        const snapshot = latest_snapshot(owner);
        await owner.__receive({ type: 'saveCsv', edits: { '0:0': 'edited-a' } });
        await flush_promises();
        expect(owner.__messages).toContainEqual(expect.objectContaining({
            type: 'saveResult', success: true,
        }));

        await owner.__receive({
            type: 'setTransform',
            sheetIndex: 0,
            requestId: 'sort-during-uncertain',
            generation: snapshot.generation,
            sourceGeneration: snapshot.sourceGeneration,
            intent: 'user',
            state: {
                sort: [{ colIndex: 0, direction: 'asc' }],
                filters: [],
                schema: '["Sheet1",1,["h"]]',
            },
        });
        expect(owner.__messages).toContainEqual(expect.objectContaining({
            type: 'transformRefused',
            requestId: 'sort-during-uncertain',
            reason: 'Finishing edit-session work; try again in a moment.',
        }));
        // A sheet-shaped transforms array survives the save; the refusal is
        // observable as sheet 0 still carrying no installed transform.
        expect(versioned.get_state(file_path).transforms?.[0]).toBeUndefined();
    });

    it('does not grant edit mode while a transform is computing', async () => {
        const warning = vi.spyOn(vscode_mock.window, 'showWarningMessage');
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
        // The refusal has to reach the user, and has to name the real reason. This is
        // the only observable `may_begin_editing()` owns on its own: the grant itself
        // is refused a second time by `may_reserve_claim()`, so without this assertion
        // the whole suite stays green with `may_begin_editing()` stubbed to yes — and
        // the user gets an unexplained no-op on the edit control.
        expect(warning).toHaveBeenCalledWith(
            'Wait for sorting and filtering to finish before entering edit mode.',
        );
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

    it('rejects current and stale transform injections at the preview host boundary', async () => {
        const file_path = '/tmp/preview-transform-injection.csv';
        const state = state_store({ columnWidths: [{ 0: 133 }] });
        const source = new TrackingTransformSource();
        const panel = open_csv_table(uri(file_path), state.store, {
            editing: false,
            previewMode: true,
            build_source: async () => source,
        });
        await panel.__receive({ type: 'ready' });
        const snapshot = latest_snapshot(panel);
        const revision = state.revision(file_path);
        const message_count = panel.__messages.length;
        const transform = {
            type: 'setTransform' as const,
            sheetIndex: 0,
            state: {
                sort: [{ colIndex: 0, direction: 'asc' as const }],
                filters: [],
                schema: '["Sheet1",1,null]',
            },
            generation: snapshot.generation,
            sourceGeneration: snapshot.sourceGeneration,
            intent: 'user' as const,
        };

        await panel.__receive({ ...transform, requestId: 'injected-current' });
        await panel.__receive({
            ...transform,
            requestId: 'injected-stale',
            generation: snapshot.generation - 1,
            sourceGeneration: snapshot.sourceGeneration - 1,
        });

        expect(source.reads).toBe(0);
        expect(panel.__messages).toHaveLength(message_count);
        expect(transform_answers(panel)).toEqual([]);
        expect(state.revision(file_path)).toBe(revision);
        expect(state.get_state(file_path)).toEqual({ columnWidths: [{ 0: 133 }] });
        expect(latest_snapshot(panel)).toMatchObject({
            generation: snapshot.generation,
            sourceGeneration: snapshot.sourceGeneration,
        });

        await panel.__receive({
            type: 'requestRows',
            sheetIndex: 0,
            startRow: 0,
            count: 3,
            requestId: 'natural-preview-rows',
            generation: snapshot.generation,
        });
        const rows = panel.__messages.find((message) => (
            typeof message === 'object'
            && message !== null
            && 'type' in message
            && message.type === 'rowData'
            && 'requestId' in message
            && message.requestId === 'natural-preview-rows'
        )) as { rows: Array<Array<{ raw: string }>> };
        expect(rows.rows.map((row) => row[0].raw)).toEqual(['c', 'a', 'b']);
    });

    it('continues to apply transforms for a normal table profile', async () => {
        const file_path = '/tmp/table-transform-positive-control.csv';
        const state = state_store();
        const source = new TrackingTransformSource();
        const panel = open_csv_table(uri(file_path), state.store, {
            editing: false,
            build_source: async () => source,
        });
        await panel.__receive({ type: 'ready' });
        const snapshot = latest_snapshot(panel);

        await panel.__receive({
            type: 'setTransform',
            sheetIndex: 0,
            requestId: 'normal-sort',
            state: {
                sort: [{ colIndex: 0, direction: 'asc' }],
                filters: [],
                schema: '["Sheet1",1,null]',
            },
            generation: snapshot.generation,
            sourceGeneration: snapshot.sourceGeneration,
            intent: 'user',
        } as never);

        const applied = basis_of(transform_installs(panel).find((message) => (
            message.requestId === 'normal-sort'
        ))!);
        expect(source.reads).toBeGreaterThan(0);
        expect(applied.generation).toBe(snapshot.generation + 1);
        expect(applied.sourceGeneration).toBe(snapshot.sourceGeneration);
        expect(state.get_state(file_path).transforms?.[0]?.sort).toEqual([
            { colIndex: 0, direction: 'asc' },
        ]);

        await panel.__receive({
            type: 'requestRows',
            sheetIndex: 0,
            startRow: 0,
            count: 3,
            requestId: 'sorted-table-rows',
            generation: applied.generation,
        });
        const rows = panel.__messages.find((message) => (
            typeof message === 'object'
            && message !== null
            && 'type' in message
            && message.type === 'rowData'
            && 'requestId' in message
            && message.requestId === 'sorted-table-rows'
        )) as { rows: Array<Array<{ raw: string }>> };
        expect(rows.rows.map((row) => row[0].raw)).toEqual(['a', 'b', 'c']);
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
