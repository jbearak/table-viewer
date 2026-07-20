import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as vscode from 'vscode';
import { attach_viewer, csv_table_profile, type ViewerProfile } from '../viewer-controller';
import type { FileStateSnapshot, FileStateStore } from '../state';
import type { PerFileState } from '../types';
import type { DataSource, RowWindow, WorkbookMeta } from '../data-source/interface';
import { versioned_state_store } from './helpers/versioned-state-store';
import * as vscode_mock from './mocks/vscode';
import { with_in_memory_authority_transactions } from '../state-authority';
import type { WorkbookSnapshotIdentity } from '../viewer-snapshot';

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
            granted: boolean;
            editSessionId?: string;
            pendingEdits?: PerFileState['pendingEdits'];
        } => (
            typeof message === 'object'
            && message !== null
            && 'type' in message
            && message.type === 'editSessionResult'
        )
    ).map(({ editSessionId: _session, ...message }) => message);
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

function latest_snapshot(panel: { __messages: unknown[] }): {
    generation: number;
    sourceGeneration: number;
    state: PerFileState;
    identity: WorkbookSnapshotIdentity;
} {
    const message = [...panel.__messages].reverse().find((candidate) => (
        typeof candidate === 'object'
        && candidate !== null
        && 'type' in candidate
        && candidate.type === 'workbookSnapshot'
        && 'snapshot' in candidate
    )) as { snapshot: {
        generation: number;
        sourceGeneration: number;
        state: PerFileState;
        identity: WorkbookSnapshotIdentity;
    } };
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
        queued.push(older, newer);

        const older_ready = panel.__receive({ type: 'ready' });
        const newer_ready = panel.__receive({ type: 'ready' });
        newer.resolve({ revision: 3, state: { columnWidths: [{ 0: 203 }] } });
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

    it('aborts an old epoch when ownership changes between state read and CAS', async () => {
        const file_path = '/tmp/pending-cas-epoch-race.csv';
        const versioned = state_store();
        const old_cas_started = deferred();
        const old_cas_gate = deferred();
        let block_old = true;
        const store: FileStateStore = {
            ...versioned.store,
            async compare_and_set(path, expected, next, validate) {
                const pending = next.pendingEdits?.['0:0'];
                if (
                    block_old
                    && typeof pending === 'object'
                    && pending?.value === 'old owner'
                ) {
                    block_old = false;
                    old_cas_started.resolve();
                    await old_cas_gate.promise;
                }
                return versioned.store.compare_and_set(path, expected, next, validate);
            },
        };
        const old_owner = open_csv_table(uri(file_path), store);
        const new_owner = open_csv_table(uri(file_path), store);
        await old_owner.__receive({ type: 'ready' });
        await new_owner.__receive({ type: 'ready' });
        await old_owner.__receive({ type: 'requestEditSession' });
        const old_session = latest_edit_session_message(old_owner)!.editSessionId!;

        const stale_write = old_owner.__receive({
            type: 'pendingEditsChanged',
            editSessionId: old_session,
            edits: { '0:0': { value: 'old owner', base: 'a' } },
        });
        await old_cas_started.promise;
        await old_owner.__receive({ type: 'releaseEditSession' });
        old_owner.dispose();

        await new_owner.__receive({ type: 'requestEditSession' });
        const new_session = latest_edit_session_message(new_owner)!.editSessionId!;
        await new_owner.__receive({
            type: 'pendingEditsChanged',
            editSessionId: new_session,
            edits: { '0:0': { value: 'new owner', base: 'a' } },
        });
        expect(versioned.get_state(file_path).pendingEdits).toEqual({
            '0:0': { value: 'new owner', base: 'a' },
        });

        old_cas_gate.resolve();
        await stale_write;
        expect(versioned.get_state(file_path).pendingEdits).toEqual({
            '0:0': { value: 'new owner', base: 'a' },
        });
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
        expect(panel.__messages).toContainEqual({ type: 'saveResult', success: true });
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
        expect(panel.__messages).toContainEqual({ type: 'saveResult', success: true });
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

        expect(panel.__messages).toContainEqual({ type: 'saveResult', success: true });
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

        expect(owner.__messages).toContainEqual({
            type: 'editSessionRevoked',
            reason: 'saved',
        });
        expect(owner.__messages.filter((message: any) => message?.type === 'saveResult'))
            .toEqual([{ type: 'saveResult', success: true }]);
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

        // The second tab captures stale state for refresh cleanup, but its generic
        // persistence reaches the host only after the first tab's direct user choice.
        const cleanup_gate = deferred();
        const delayed_cleanup = cleanup_gate.promise.then(() => second.__receive({
            type: 'stateChanged', sourceGeneration: 1, state: { columnVisibility: [undefined], activeSheetIndex: 0 },
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
            type: 'stateChanged', sourceGeneration: 1, state: {
                columnVisibility: [{ visibleColumns: [], schema }], activeSheetIndex: 0,
            },
        } as never);
        expect(state.get_state(file_path).columnVisibility).toEqual([undefined]);
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

        // This is the snapshot the webview posts after sanitizing initial metadata.
        await panel.__receive({
            type: 'stateChanged',
            sourceGeneration: 1,
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
            sourceGeneration: 1,
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
