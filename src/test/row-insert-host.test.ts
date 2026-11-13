// Row insert through the controller (row and column structure design,
// delivery step 6): `requestStructuralInsert` admission and every refusal,
// the shared reservation slot and Pending Row limit, the host ordering rules
// against save, discard, remount, and source refresh, publication of inserted
// rows and their tombstones, the origin rule for "Keep new rows at the end",
// and a CSV save that writes inserted rows and rekeys their view state.
import { createHash } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type * as vscode from 'vscode';
import {
    attach_viewer,
    csv_table_profile,
    simulate_process_restart_for_tests,
    STRUCTURAL_INSERT_GATE_MESSAGE,
    UNSETTLED_ADMISSION_SAVE_MESSAGE,
} from '../viewer-controller';
import { with_in_memory_authority_transactions } from '../state-authority';
import {
    transform_schema_for_sheet,
    type PerFileState,
    type WorksheetPendingEdits,
} from '../types';
import { MAX_PENDING_APPENDED_ROWS, type PendingAppendedRow, type StructuralBasis } from '../pending-changes';
import { versioned_state_store } from './helpers/versioned-state-store';
import * as vscode_mock from './mocks/vscode';
import { fake_viewer_host } from './mocks/host-ports';

const enc = new TextEncoder();
const dec = new TextDecoder();
// One header and three body rows: canonical source rows 0-2, two columns.
const BYTES = enc.encode('h1,h2\na,1\nb,2\nc,3\n');
const FILE = '/tmp/row-insert-host.csv';
const SCHEMA = transform_schema_for_sheet({
    name: 'Sheet1',
    columnCount: 2,
    columnNames: ['h1', 'h2'],
} as never);

const hex = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');

function basis_of(bytes: Uint8Array, rows: number): StructuralBasis {
    return {
        kind: 'delimited',
        byteLength: bytes.byteLength,
        digest: hex(bytes),
        sourceRowCount: rows,
        sourceColumnCount: 2,
    };
}

const BASIS = basis_of(BYTES, 3);

afterEach(() => {
    for (const panel of vscode_mock.__getPanels()) panel.dispose();
    vi.restoreAllMocks();
    vscode_mock.__reset();
    simulate_process_restart_for_tests();
});

type Message = { type?: string } & Record<string, unknown>;

interface InsertReply {
    readonly type: 'structuralInsertResult';
    readonly requestId: string;
    readonly granted: boolean;
    readonly rowIds?: readonly string[];
    readonly formatTemplate?: { readonly id: string; readonly format: { readonly kind: string } };
    readonly structuralBasis?: StructuralBasis;
    readonly appendBasis?: Record<string, unknown>;
    readonly reason?: string;
}

interface InsertRequest {
    readonly requestId: string;
    readonly anchor?: unknown;
    readonly side?: 'before' | 'after';
    readonly count?: number;
    readonly axis?: 'rows' | 'columns';
    readonly sourceGeneration?: number;
    readonly editSessionId?: string;
}

/** A pausable gate on durable state reads: arm it, then release it. */
function read_gate() {
    let armed = false;
    let release: (() => void) | undefined;
    let reached: (() => void) | undefined;
    let reached_promise = new Promise<void>((resolve) => { reached = resolve; });
    return {
        arm() {
            armed = true;
            reached_promise = new Promise<void>((resolve) => { reached = resolve; });
        },
        /** Resolves once an armed read is waiting. */
        reached: () => reached_promise,
        release() {
            release?.();
            release = undefined;
        },
        async before_read() {
            if (!armed) return;
            armed = false;
            reached?.();
            await new Promise<void>((resolve) => { release = resolve; });
        },
    };
}

async function open_viewer(options: {
    readonly state?: ReturnType<typeof versioned_state_store>;
    readonly bytes?: Uint8Array;
    readonly structuralEditingEnabled?: boolean;
    readonly path?: string;
} = {}) {
    const file = { bytes: options.bytes ?? BYTES, mtime: 1, hang_write: false, hung: false };
    vscode_mock.__setStatImplementation(async () => ({ size: file.bytes.length, mtime: file.mtime }));
    vscode_mock.__setReadFileImplementation(async () => file.bytes);
    vscode_mock.__setWriteFileImplementation(async (_uri, content) => {
        if (file.hang_write) {
            file.hung = true;
            return new Promise<never>(() => {});
        }
        file.bytes = content;
        file.mtime += 1;
    });
    const state = options.state ?? versioned_state_store({});
    const gate = read_gate();
    const path = options.path ?? FILE;
    const panel = vscode_mock.window.createWebviewPanel('tableViewer.editor', 'table');
    const controller = attach_viewer(
        panel as unknown as Parameters<typeof attach_viewer>[0],
        vscode_mock.Uri.file(path) as unknown as vscode.Uri,
        with_in_memory_authority_transactions({
            ...state.store,
            read: async (file_path) => {
                await gate.before_read();
                return state.store.read(file_path);
            },
        }),
        csv_table_profile(),
        fake_viewer_host,
        { structuralEditingEnabled: options.structuralEditingEnabled ?? true },
    );
    panel.onDidDispose(() => controller.dispose());
    const warning = vi.spyOn(vscode_mock.window, 'showWarningMessage');
    warning.mockClear();
    await panel.__receive({ type: 'ready', structuralLayout: 1 });
    await panel.__receive({ type: 'requestEditSession', requestId: 'edit' });
    await controller.drain();
    const messages = () => panel.__messages as Message[];
    const last = <T,>(type: string) => [...messages()].reverse().find((message) => message.type === type) as T;
    const session_id = () => last<{ editSessionId?: string }>('editSessionResult')?.editSessionId;
    const generation = () => last<{ snapshot: { sourceGeneration: number } }>('workbookSnapshot')
        .snapshot.sourceGeneration;
    let sequence = 0;
    const viewer = {
        panel,
        controller,
        state,
        file,
        gate,
        warning,
        messages,
        last,
        session_id,
        generation,
        durable: () => state.get_state(path) as PerFileState,
        /** Send an insert request; not awaited, so a test can pause it. */
        send_insert(request: InsertRequest): Promise<void> {
            return panel.__receive({
                type: 'requestStructuralInsert',
                requestId: request.requestId,
                editSessionId: request.editSessionId ?? session_id()!,
                worksheet: { sheetIndex: 0, sheetName: 'Sheet1' },
                sourceGeneration: request.sourceGeneration ?? generation(),
                axis: request.axis ?? 'rows',
                anchor: request.anchor ?? { row: { kind: 'source', sourceRow: 0 } },
                side: request.side ?? 'after',
                count: request.count ?? 1,
            }) as Promise<void>;
        },
        reply(request_id: string): InsertReply | undefined {
            return [...messages()].reverse().find((message) =>
                message.type === 'structuralInsertResult' && message.requestId === request_id) as never;
        },
        async insert(request: InsertRequest): Promise<InsertReply> {
            await viewer.send_insert(request);
            await controller.drain();
            return viewer.reply(request.requestId)!;
        },
        async settle(request_id: string, accepted: boolean): Promise<void> {
            await panel.__receive({
                type: 'settleRowAdmission',
                requestId: request_id,
                editSessionId: session_id()!,
                accepted,
            });
            await controller.drain();
        },
        async append(request_id: string, count: number): Promise<{ granted: boolean; rowIds?: string[] }> {
            await panel.__receive({
                type: 'requestAppendRows',
                requestId: request_id,
                editSessionId: session_id()!,
                worksheet: { sheetIndex: 0, sheetName: 'Sheet1' },
                sourceGeneration: generation(),
                count,
            });
            await controller.drain();
            return [...messages()].reverse().find((message) =>
                message.type === 'appendRowsResult' && message.requestId === request_id) as never;
        },
        async publish(changes: Partial<WorksheetPendingEdits>): Promise<boolean> {
            sequence += 1;
            const at = sequence;
            await panel.__receive({
                type: 'pendingChangesChanged',
                editSessionId: session_id()!,
                sequence: at,
                sourceGeneration: generation(),
                changes: {
                    sheetIndex: 0,
                    sheetName: 'Sheet1',
                    cells: {},
                    formatTemplates: [],
                    appendedRows: [],
                    tailRemovals: [],
                    conflicts: [],
                    ...changes,
                },
            });
            await controller.drain();
            return messages().some((message) =>
                message.type === 'pendingChangesAcknowledged' && message.sequence === at);
        },
        send_save(
            structural: Partial<WorksheetPendingEdits>,
            cells: Record<string, { value: string; base: string }> = {},
        ): Promise<void> {
            return panel.__receive({
                type: 'saveCsv',
                operation: {
                    editSessionId: session_id()!,
                    saveRequestId: `save-${Math.random()}`,
                    worksheets: [{
                        sheetIndex: 0,
                        sheetName: 'Sheet1',
                        edits: Object.fromEntries(Object.entries(cells).map(([key, cell]) => [key, cell.value])),
                        dirtyEdits: cells,
                        structuralChanges: {
                            formatTemplates: [],
                            appendedRows: [],
                            tailRemovals: [],
                            conflicts: [],
                            ...structural,
                        },
                    }],
                },
            }) as Promise<void>;
        },
        async save(structural: Partial<WorksheetPendingEdits>) {
            await viewer.send_save(structural);
            await controller.drain();
            return last<{ success: boolean; receipt?: unknown; rejection?: unknown }>('saveResult');
        },
        async dispose() {
            panel.dispose();
            await controller.drain();
        },
    };
    return viewer;
}

function inserted(id: string, template: string, createdOrder: number, extra: Partial<PendingAppendedRow> = {}) {
    return { id, origin: 'insert' as const, cells: {}, formatTemplateId: template, createdOrder, ...extra };
}

/** The layout an insert of `ids` after source row 0 makes on a three-row body. */
function layout_after_first(ids: readonly string[], discarded: readonly { id: string; createdOrder: number }[] = []) {
    return {
        runs: [
            { kind: 'source' as const, start: 0, count: 1 },
            { kind: 'pending' as const, ids: [...ids, ...discarded.map((row) => row.id)] },
            { kind: 'source' as const, start: 1, count: 2 },
        ],
        removedSourceRows: [],
        discardedPendingRows: [...discarded],
    };
}

/** The complete Pending Changes of an admitted insert after source row 0. */
function insert_changes(reply: InsertReply, rows = reply.rowIds!.map((id, index) =>
    inserted(id, reply.formatTemplate!.id, index + 1))): Partial<WorksheetPendingEdits> {
    return {
        formatTemplates: [reply.formatTemplate as never],
        appendedRows: rows as never,
        appendBasis: reply.appendBasis as never,
        rowLayout: layout_after_first(rows.map((row) => row.id)),
        structuralBasis: reply.structuralBasis!,
    };
}

describe('insert admission', () => {
    it('mints insert-origin IDs with the format template, the Structural Basis, and the append basis', async () => {
        const viewer = await open_viewer();
        const reply = await viewer.insert({ requestId: 'ins', count: 2 });
        expect(reply).toMatchObject({
            granted: true,
            rowIds: [expect.stringMatching(/^insert-row:/), expect.stringMatching(/^insert-row:/)],
            formatTemplate: { format: { kind: 'none' } },
            structuralBasis: BASIS,
            appendBasis: {
                sourceRowCount: 3,
                provisionalStartRow: 3,
                provisionalRowCount: 0,
                columnCount: 2,
            },
        });
        // The snapshot reports the same basis a first Delete would record.
        const snapshot = viewer.last<{ snapshot: { capabilities: { structuralEditing?: { sheets: { basis?: unknown }[] } } } }>(
            'workbookSnapshot');
        expect(snapshot.snapshot.capabilities.structuralEditing?.sheets[0]?.basis).toEqual(BASIS);
        await viewer.dispose();
    });

    it('checks an existing append basis instead of minting a new one', async () => {
        const viewer = await open_viewer();
        const appended = await viewer.append('app', 2);
        expect(appended.granted).toBe(true);
        await viewer.settle('app', true);
        const reply = await viewer.insert({ requestId: 'ins' });
        expect(reply.granted).toBe(true);
        // Inserted rows are not in the band, so its high-water mark stays at 2.
        expect(reply.appendBasis).toMatchObject({ provisionalStartRow: 3, provisionalRowCount: 2 });
        await viewer.dispose();
    });

    it('refuses with the flag off, on .xlsx, for columns, and for malformed requests', async () => {
        const off = await open_viewer({ structuralEditingEnabled: false });
        expect(await off.insert({ requestId: 'off' })).toMatchObject({ granted: false });
        await off.dispose();

        const xlsx = await open_viewer({ path: '/tmp/row-insert-host.xlsx' });
        expect(await xlsx.insert({ requestId: 'xlsx' })).toMatchObject({
            granted: false,
            reason: 'Not available yet',
        });
        await xlsx.dispose();

        const viewer = await open_viewer();
        expect(await viewer.insert({ requestId: 'cols', axis: 'columns', anchor: { column: { kind: 'source', sourceColumn: 0 } } }))
            .toMatchObject({ granted: false, reason: 'Inserting columns is not available yet.' });
        expect(await viewer.insert({ requestId: 'zero', count: 0 })).toMatchObject({ granted: false });
        expect(await viewer.insert({ requestId: 'many', count: MAX_PENDING_APPENDED_ROWS + 1 }))
            .toMatchObject({ granted: false });
        expect(await viewer.insert({ requestId: 'past', anchor: { row: { kind: 'source', sourceRow: 3 } } }))
            .toMatchObject({ granted: false, reason: "Rows can't be inserted above the header row." });
        expect(await viewer.insert({ requestId: 'shape', anchor: { row: { kind: 'other' } } }))
            .toMatchObject({ granted: false });
        expect(await viewer.insert({ requestId: 'stale', sourceGeneration: viewer.generation() - 1 }))
            .toMatchObject({ granted: false, reason: 'The edit session or worksheet changed. Try inserting again.' });
        expect(await viewer.insert({ requestId: 'session', editSessionId: 'someone-else' }))
            .toMatchObject({ granted: false });
        // Nothing was reserved by any refusal: the slot is free.
        expect(await viewer.insert({ requestId: 'ok' })).toMatchObject({ granted: true });
        await viewer.dispose();
    });

    it('refuses a reused request identity while it is active', async () => {
        const viewer = await open_viewer();
        expect(await viewer.insert({ requestId: 'same' })).toMatchObject({ granted: true });
        await viewer.send_insert({ requestId: 'same' });
        await viewer.controller.drain();
        expect(viewer.reply('same')).toMatchObject({
            granted: false,
            reason: 'This row-admission request identity is already active.',
        });
        await viewer.dispose();
    });

    it('shares one reservation slot with appends', async () => {
        const viewer = await open_viewer();
        expect(await viewer.insert({ requestId: 'first' })).toMatchObject({ granted: true });
        expect(await viewer.insert({ requestId: 'second' })).toMatchObject({
            granted: false,
            reason: 'Another row append is still being installed. Try again.',
        });
        expect(await viewer.append('app', 1)).toMatchObject({ granted: false });
        await viewer.settle('first', false);
        expect(await viewer.append('app-2', 1)).toMatchObject({ granted: true });
        expect(await viewer.insert({ requestId: 'third' })).toMatchObject({ granted: false });
        await viewer.dispose();
    });

    it('counts appends, inserts, and discarded tombstones against one 10,000-row limit', async () => {
        const viewer = await open_viewer();
        expect(await viewer.append('app', MAX_PENDING_APPENDED_ROWS - 1)).toMatchObject({ granted: true });
        await viewer.settle('app', true);
        expect(await viewer.insert({ requestId: 'two', count: 2 })).toMatchObject({
            granted: false,
            reason: 'A worksheet may keep at most 10,000 pending rows.',
        });
        expect(await viewer.insert({ requestId: 'one', count: 1 })).toMatchObject({ granted: true });
        await viewer.dispose();

        // A discarded tombstone restored from durable state is an admission too.
        const tombstoned = await open_viewer({
            state: versioned_state_store({
                pendingEdits: [{
                    sheetName: 'Sheet1',
                    cells: {},
                    rowLayout: layout_after_first([], [{ id: 'gone', createdOrder: 1 }]),
                }],
            }),
        });
        expect(await tombstoned.insert({ requestId: 'all', count: MAX_PENDING_APPENDED_ROWS }))
            .toMatchObject({ granted: false, reason: 'A worksheet may keep at most 10,000 pending rows.' });
        expect(await tombstoned.insert({ requestId: 'rest', count: MAX_PENDING_APPENDED_ROWS - 1 }))
            .toMatchObject({ granted: true });
        await tombstoned.dispose();
    });

    it('refuses under a pending cell move', async () => {
        const moved = await open_viewer({
            state: versioned_state_store({
                pendingEdits: [{
                    sheetName: 'Sheet1',
                    cells: {
                        '1:0': { value: 'a', base: 'b', movedFrom: { order: 1 } },
                        '0:0': { value: '', base: 'a', movedFrom: { order: 1 } },
                    },
                }] as never,
            }),
        });
        // The fixture's move survives load, so the refusal is always checked.
        expect(Object.keys(moved.durable().pendingEdits?.[0]?.cells ?? {})).toEqual(['1:0', '0:0']);
        expect(await moved.insert({ requestId: 'move' })).toMatchObject({
            granted: false,
            reason: 'Save or undo the moved cells first.',
        });
        await moved.dispose();
    });

    it('refuses once the recorded Structural Basis no longer names the file', async () => {
        const viewer = await open_viewer({
            state: versioned_state_store({
                pendingEdits: [{
                    sheetName: 'Sheet1',
                    cells: {},
                    rowLayout: {
                        runs: [{ kind: 'source', start: 0, count: 3 }],
                        removedSourceRows: [{ start: 1, count: 1 }],
                        discardedPendingRows: [],
                    },
                    structuralBasis: basis_of(enc.encode('h1,h2\nold\n'), 3),
                }],
            }),
        });
        const reply = await viewer.insert({ requestId: 'basis' });
        expect(reply.granted).toBe(false);
        expect(reply.reason).toContain('changed on disk after you inserted, deleted, or moved rows or columns');
        await viewer.dispose();
    });
});

describe('host ordering rules', () => {
    it('holds an admission that arrives while a save is writing until the save is done', async () => {
        // Before the request: the save holds the authority tail across its
        // write, so the admission waits and no grant can land between the
        // bytes the save planned and the write.
        const viewer = await open_viewer();
        viewer.file.hang_write = true;
        void viewer.send_save({}, { '0:0': { value: 'x', base: 'a' } });
        await vi.waitFor(() => expect(viewer.file.hung).toBe(true));
        void viewer.send_insert({ requestId: 'during-save' });
        for (let turn = 0; turn < 20; turn += 1) await new Promise<void>((resolve) => setImmediate(resolve));
        expect(viewer.reply('during-save')).toBeUndefined();
        viewer.panel.dispose();
    });

    it('refuses an admission when a save starts between request and reply, and the save goes ahead', async () => {
        const viewer = await open_viewer();
        viewer.gate.arm();
        const request = viewer.send_insert({ requestId: 'paused' });
        await viewer.gate.reached();
        const save = viewer.send_save({}, { '0:0': { value: 'x', base: 'a' } });
        viewer.gate.release();
        await Promise.all([request, save]);
        await viewer.controller.drain();
        expect(viewer.reply('paused')).toMatchObject({ granted: false, reason: STRUCTURAL_INSERT_GATE_MESSAGE });
        expect(viewer.last('saveResult')).toMatchObject({ success: true });
        expect(dec.decode(viewer.file.bytes)).toBe('h1,h2\nx,1\nb,2\nc,3\n');
        await viewer.dispose();
    });

    it('refuses admission while a discard’s cleanup holds the gate', async () => {
        const viewer = await open_viewer();
        expect(STRUCTURAL_INSERT_GATE_MESSAGE).toContain('discard');
        const session = viewer.session_id()!;
        await viewer.panel.__receive({ type: 'discardEditSession', editSessionId: session });
        await viewer.controller.drain();
        // The discarded session can no longer admit anything.
        expect(await viewer.insert({ requestId: 'after-discard', editSessionId: session }))
            .toMatchObject({ granted: false });
        await viewer.dispose();
    });

    it('refuses an admission whose source refreshed between request and reply', async () => {
        const viewer = await open_viewer();
        const generation = viewer.generation();
        viewer.gate.arm();
        const request = viewer.send_insert({ requestId: 'refresh' });
        await viewer.gate.reached();
        viewer.file.bytes = enc.encode('h1,h2\na,1\nb,2\nc,3\nd,4\n');
        viewer.file.mtime = 2;
        await vscode_mock.__getWatchers()[0]!.__fireChange();
        await vi.waitFor(() => expect(viewer.generation()).toBeGreaterThan(generation));
        viewer.gate.release();
        await request;
        await viewer.controller.drain();
        expect(viewer.reply('refresh')?.granted).toBe(false);
        await viewer.dispose();
    });

    it('refuses an admission whose session was discarded between request and reply', async () => {
        const viewer = await open_viewer();
        const session = viewer.session_id()!;
        viewer.gate.arm();
        const request = viewer.send_insert({ requestId: 'discard' });
        await viewer.gate.reached();
        const discarded = viewer.panel.__receive({ type: 'discardEditSession', editSessionId: session });
        viewer.gate.release();
        await Promise.all([request, discarded]);
        await viewer.controller.drain();
        expect(viewer.reply('discard')?.granted).toBe(false);
        await viewer.dispose();
    });

    it('releases a reply the remounted webview can no longer receive', async () => {
        const viewer = await open_viewer();
        viewer.gate.arm();
        const request = viewer.send_insert({ requestId: 'remount' });
        await viewer.gate.reached();
        await viewer.panel.__receive({ type: 'ready', structuralLayout: 1 });
        viewer.gate.release();
        await request;
        await viewer.controller.drain();
        expect(viewer.reply('remount')?.granted ?? false).toBe(false);
        // No reservation survived: a fresh request in the current session is
        // not told another insert is still being installed.
        if (viewer.session_id() !== undefined) {
            await viewer.panel.__receive({ type: 'requestEditSession', requestId: 'again' });
            await viewer.controller.drain();
            const reply = await viewer.insert({ requestId: 'after-remount' });
            expect(reply.reason).not.toBe('Another row append is still being installed. Try again.');
        }
        await viewer.dispose();
    });

    it('refuses a save between reply and settle, then saves once the insert settles', async () => {
        const viewer = await open_viewer();
        const reply = await viewer.insert({ requestId: 'ins' });
        expect(reply.granted).toBe(true);
        const refused = await viewer.save({});
        expect(refused).toMatchObject({ success: false });
        expect(viewer.warning).toHaveBeenCalledWith(UNSETTLED_ADMISSION_SAVE_MESSAGE);
        expect(dec.decode(viewer.file.bytes)).toBe(dec.decode(BYTES));

        await viewer.settle('ins', true);
        expect(await viewer.publish(insert_changes(reply))).toBe(true);
        expect(await viewer.save(insert_changes(reply))).toMatchObject({ success: true });
        expect(dec.decode(viewer.file.bytes)).toBe('h1,h2\na,1\n,\nb,2\nc,3\n');
        await viewer.dispose();
    });

    it('forgets a reply settled as released, and a late settle after discard changes nothing', async () => {
        const viewer = await open_viewer();
        const reply = await viewer.insert({ requestId: 'released' });
        await viewer.settle('released', false);
        // A publication naming the released rows is refused: the IDs are gone.
        expect(await viewer.publish(insert_changes(reply))).toBe(false);

        const second = await viewer.insert({ requestId: 'late' });
        expect(second.granted).toBe(true);
        const session = viewer.session_id()!;
        await viewer.panel.__receive({ type: 'discardEditSession', editSessionId: session });
        await viewer.controller.drain();
        await viewer.panel.__receive({
            type: 'settleRowAdmission',
            requestId: 'late',
            editSessionId: session,
            accepted: true,
        });
        await viewer.controller.drain();
        expect(viewer.durable().pendingEdits).toBeUndefined();
        await viewer.dispose();
    });

    it('after settle: a source refresh that changes the file conflicts the published layout', async () => {
        const viewer = await open_viewer();
        const reply = await viewer.insert({ requestId: 'ins' });
        await viewer.settle('ins', true);
        expect(await viewer.publish(insert_changes(reply))).toBe(true);
        viewer.file.bytes = enc.encode('h1,h2\na,1\nB,2\nc,3\n');
        viewer.file.mtime = 2;
        await vscode_mock.__getWatchers()[0]!.__fireChange();
        await viewer.controller.drain();
        await vi.waitFor(() => expect(viewer.durable().pendingEdits?.[0]?.conflicts)
            .toEqual([{ reason: 'structuralBasisChanged', pendingRowIds: [], tailRemovalIds: [] }]));
        // A further insert waits for Review Changes.
        expect((await viewer.insert({ requestId: 'more' })).granted).toBe(false);
        await viewer.dispose();
    });
});

describe('publishing inserted rows', () => {
    it('accepts a discarded tombstone the ledger minted, in the gesture’s first publication', async () => {
        const viewer = await open_viewer();
        const reply = await viewer.insert({ requestId: 'ins', count: 3 });
        await viewer.settle('ins', true);
        const [kept_a, kept_b, gone] = reply.rowIds!;
        const template = reply.formatTemplate!.id;
        const changes: Partial<WorksheetPendingEdits> = {
            formatTemplates: [reply.formatTemplate as never],
            appendedRows: [inserted(kept_a!, template, 1), inserted(kept_b!, template, 2)] as never,
            appendBasis: reply.appendBasis as never,
            rowLayout: layout_after_first([kept_a!, kept_b!], [{ id: gone!, createdOrder: 3 }]),
            structuralBasis: reply.structuralBasis!,
        };
        expect(await viewer.publish(changes)).toBe(true);
        expect(viewer.durable().pendingEdits?.[0]?.rowLayout?.discardedPendingRows).toEqual([
            { id: gone, createdOrder: 3 },
        ]);
        // The tombstone stays publishable, and the payload saves.
        expect(await viewer.publish(changes)).toBe(true);
        expect(await viewer.save(changes)).toMatchObject({ success: true });
        expect(dec.decode(viewer.file.bytes)).toBe('h1,h2\na,1\n,\n,\nb,2\nc,3\n');
        await viewer.dispose();
    });

    it('accepts origin `append` for an inserted row and back, never `insert` for an appended row', async () => {
        const viewer = await open_viewer();
        const reply = await viewer.insert({ requestId: 'ins' });
        await viewer.settle('ins', true);
        const id = reply.rowIds![0]!;
        const template = reply.formatTemplate!.id;
        expect(await viewer.publish(insert_changes(reply))).toBe(true);
        // "Keep new rows at the end": the row becomes an append, past the band.
        const kept: Partial<WorksheetPendingEdits> = {
            formatTemplates: [reply.formatTemplate as never],
            appendedRows: [{ id, cells: {}, formatTemplateId: template, createdOrder: 7 }] as never,
            appendBasis: reply.appendBasis as never,
        };
        expect(await viewer.publish(kept)).toBe(true);
        expect(viewer.durable().pendingEdits?.[0]?.rowLayout).toBeUndefined();
        // Its Undo: the row is inserted again.
        expect(await viewer.publish(insert_changes(reply))).toBe(true);

        const appended = await viewer.append('app', 1);
        expect((appended as { reason?: string }).reason).toBeUndefined();
        await viewer.settle('app', true);
        const posing = inserted(appended.rowIds![0]!, template, 9);
        expect(await viewer.publish({
            ...insert_changes(reply),
            appendedRows: [inserted(id, template, 1), posing] as never,
            rowLayout: layout_after_first([id, posing.id]),
        })).toBe(false);
        await viewer.dispose();
    });
});

describe('saving inserted rows', () => {
    it('writes them in layout position and rekeys their highlights and heights to the saved rows', async () => {
        const state = versioned_state_store({
            cellHighlights: {
                sourceDigest: hex(BYTES),
                sheets: [{ schema: SCHEMA, cells: { '1:0': 'green' } }],
            },
            rowHeights: [{ 1: 31 }],
        });
        const viewer = await open_viewer({ state });
        const reply = await viewer.insert({ requestId: 'ins', side: 'before', anchor: { row: { kind: 'source', sourceRow: 1 } } });
        await viewer.settle('ins', true);
        const row = inserted(reply.rowIds![0]!, reply.formatTemplate!.id, 1, {
            cells: { 1: { value: 'new', valueEditOrder: 1 } },
            highlights: { 0: 'yellow' },
            viewerRowHeight: 44,
        } as never);
        const changes = insert_changes(reply, [row]);
        expect(await viewer.publish(changes)).toBe(true);
        const result = await viewer.save(changes);
        expect(result).toMatchObject({
            success: true,
            receipt: {
                appendedRows: [],
                structure: [{
                    rowRuns: [{ from: 0, count: 1, to: 0 }, { from: 1, count: 2, to: 2 }],
                    removedRows: [],
                    insertedRows: [{ pendingRowId: row.id, sourceRow: 1 }],
                }],
            },
        });
        expect(dec.decode(viewer.file.bytes)).toBe('h1,h2\na,1\n,new\nb,2\nc,3\n');
        await vi.waitFor(() => expect(viewer.durable().pendingEdits).toBeUndefined());
        expect(viewer.durable().cellHighlights?.sheets[0]?.cells).toEqual({ '1:0': 'yellow', '2:0': 'green' });
        expect(viewer.durable().rowHeights?.[0]).toEqual({ 1: 44, 2: 31 });
        expect(viewer.durable().structuralRekeyIntent).toBeUndefined();
        await viewer.dispose();
    });
});

describe('review fixes', () => {
    it('accepts a publication of part of an insert gesture whose other rows were deleted', async () => {
        const viewer = await open_viewer();
        const reply = await viewer.insert({ requestId: 'ins', count: 2 });
        await viewer.settle('ins', true);
        const [a, b] = reply.rowIds!;
        const template = reply.formatTemplate!.id;
        // `b` was deleted before the gesture's first publication, and its
        // tombstone dropped: only `a` is published.
        const only_a = insert_changes(reply, [inserted(a!, template, 1)]);
        expect(await viewer.publish(only_a)).toBe(true);
        // Undo of that delete brings `b` back; its ID is still owned.
        expect(await viewer.publish(insert_changes(reply))).toBe(true);
        expect(await viewer.publish(only_a)).toBe(true);
        expect(await viewer.save(only_a)).toMatchObject({ success: true });
        expect(dec.decode(viewer.file.bytes)).toBe('h1,h2\na,1\n,\nb,2\nc,3\n');
        void b;
        await viewer.dispose();
    });

    function set_transform(viewer: Awaited<ReturnType<typeof open_viewer>>, request_id: string) {
        const snapshot = viewer.last<{ snapshot: { generation: number; sourceGeneration: number } }>(
            'workbookSnapshot').snapshot;
        return viewer.panel.__receive({
            type: 'setTransform',
            sheetIndex: 0,
            requestId: request_id,
            generation: snapshot.generation,
            sourceGeneration: snapshot.sourceGeneration,
            intent: 'user',
            state: { sort: [{ colIndex: 0, direction: 'asc' }], filters: [], schema: SCHEMA },
        } as never) as Promise<void>;
    }

    it('refuses a sort commit while an insert is outstanding or inserted rows exist', async () => {
        const viewer = await open_viewer();
        const reply = await viewer.insert({ requestId: 'ins' });
        expect(reply.granted).toBe(true);
        // Unsettled admission: the sort may not commit.
        await set_transform(viewer, 'sort-unsettled');
        await viewer.controller.drain();
        expect(viewer.durable().transforms?.[0]).toBeUndefined();

        await viewer.settle('ins', true);
        expect(await viewer.publish(insert_changes(reply))).toBe(true);
        // Inserted rows in durable Pending Changes: still refused.
        await set_transform(viewer, 'sort-inserted');
        await viewer.controller.drain();
        expect(viewer.durable().transforms?.[0]).toBeUndefined();

        // Once the inserted rows are gone, sorting works again.
        expect(await viewer.publish({})).toBe(true);
        await set_transform(viewer, 'sort-after');
        await viewer.controller.drain();
        expect(viewer.durable().transforms?.[0]).toMatchObject({ sort: [{ colIndex: 0, direction: 'asc' }] });
        await viewer.dispose();
    });

    it('refuses an insert under an installed sort and while a sort is in flight', async () => {
        const sorted = await open_viewer({
            state: versioned_state_store({
                transforms: [{ sort: [{ colIndex: 0, direction: 'desc' }], filters: [], schema: SCHEMA }],
            }),
        });
        expect(await sorted.insert({ requestId: 'sorted' })).toMatchObject({
            granted: false,
            reason: 'Clear sorts, filters, and hidden rows to insert or move rows.',
        });
        await sorted.dispose();

        const viewer = await open_viewer();
        viewer.gate.arm();
        const sort = set_transform(viewer, 'sort-in-flight');
        await viewer.gate.reached();
        // The reply is posted while the sort is still computing (its handler
        // stays parked behind the paused read, so poll rather than await it).
        void viewer.send_insert({ requestId: 'during-sort' });
        await vi.waitFor(() => expect(viewer.reply('during-sort')).toMatchObject({
            granted: false,
            reason: STRUCTURAL_INSERT_GATE_MESSAGE,
        }));
        viewer.gate.release();
        await sort;
        await viewer.dispose();
    });

    it('replays inserted rows into a new session, keeping their insert origin', async () => {
        const viewer = await open_viewer();
        const reply = await viewer.insert({ requestId: 'ins' });
        await viewer.settle('ins', true);
        const id = reply.rowIds![0]!;
        // History retains the row, as the webview reports.
        await viewer.panel.__receive({
            type: 'retainedSavedAppendAuthoritiesChanged',
            authorities: [{ sheetIndex: 0, sheetName: 'Sheet1', appendHistoryIds: [], pendingRowIds: [id] }],
        });
        const changes = insert_changes(reply, [inserted(id, reply.formatTemplate!.id, 1, {
            cells: { 0: { value: 'typed', valueEditOrder: 1 } },
        } as never)]);
        expect(await viewer.publish(changes)).toBe(true);
        // Undo the insert, then leave Edit mode: the session's ledger hands
        // the row's authority to the retained store.
        expect(await viewer.publish({})).toBe(true);
        await viewer.panel.__receive({ type: 'releaseEditSession', editSessionId: viewer.session_id()! });
        await viewer.controller.drain();

        // Back in Edit mode, Redo replays the insert against a new ledger.
        await viewer.panel.__receive({ type: 'requestEditSession', requestId: 'again' });
        await viewer.controller.drain();
        expect(viewer.last<{ granted: boolean }>('editSessionResult').granted).toBe(true);
        const empty = { formatTemplates: [], appendedRows: [], tailRemovals: [], conflicts: [] };
        await viewer.panel.__receive({
            type: 'prepareHistoryReplay',
            request: {
                requestId: 'redo-prepare',
                replayId: 'redo-replay',
                cells: [],
                highlights: [],
                structures: [{
                    ordinal: 0,
                    worksheet: { sheetIndex: 0, sheetName: 'Sheet1' },
                    expected: empty,
                    desired: changes,
                }],
                focus: {
                    worksheet: { sheetIndex: 0, sheetName: 'Sheet1' },
                    sourceRowStart: 0,
                    sourceRowEnd: 0,
                    sourceColumnStart: 0,
                    sourceColumnEnd: 0,
                },
            },
        });
        await viewer.controller.drain();
        await vi.waitFor(() => expect(viewer.messages().some((message) =>
            message.type === 'historyReplayPrepared'
            || message.type === 'historyReplayPrepareRefused')).toBe(true));
        expect(viewer.last<{ type: string }>('historyReplayPrepareRefused')).toBeUndefined();
        // The publication the replay leads to is accepted, origin and all.
        expect(await viewer.publish(changes)).toBe(true);
        expect(viewer.durable().pendingEdits?.[0]?.appendedRows).toEqual([
            expect.objectContaining({ id, origin: 'insert' }),
        ]);
        await viewer.dispose();
    });
});

describe('moving rows (delivery step 7)', () => {
    const moved_layout = {
        // c, a, b: source row 2 moved to the top.
        runs: [
            { kind: 'source' as const, start: 2, count: 1 },
            { kind: 'source' as const, start: 0, count: 2 },
        ],
        removedSourceRows: [],
        discardedPendingRows: [],
    };

    it('publishes a move without any admission, and refuses sorting while moved rows exist', async () => {
        const viewer = await open_viewer();
        expect(await viewer.publish({ rowLayout: moved_layout, structuralBasis: BASIS })).toBe(true);
        expect(viewer.durable().pendingEdits?.[0]?.rowLayout).toEqual(moved_layout);
        await viewer.panel.__receive({
            type: 'setTransform',
            sheetIndex: 0,
            requestId: 'sort-moved',
            generation: viewer.last<{ snapshot: { generation: number } }>('workbookSnapshot').snapshot.generation,
            sourceGeneration: viewer.generation(),
            intent: 'user',
            state: { sort: [{ colIndex: 0, direction: 'asc' }], filters: [], schema: SCHEMA },
        } as never);
        await viewer.controller.drain();
        expect(viewer.durable().transforms?.[0]).toBeUndefined();
        await viewer.dispose();
    });

    it('refuses a published move whose layout breaks an invariant', async () => {
        const viewer = await open_viewer();
        expect(await viewer.publish({
            rowLayout: { ...moved_layout, runs: [{ kind: 'source', start: 2, count: 1 }, { kind: 'source', start: 0, count: 1 }] },
            structuralBasis: BASIS,
        })).toBe(false);
        await viewer.dispose();
    });

    it('saves moves with a delete, an insert, and an append, and rekeys highlights and heights', async () => {
        const state = versioned_state_store({
            cellHighlights: {
                sourceDigest: hex(BYTES),
                sheets: [{ schema: SCHEMA, cells: { '0:0': 'green', '1:1': 'pink', '2:1': 'yellow' } }],
            },
            rowHeights: [{ 0: 20, 1: 21, 2: 22 }],
        });
        const viewer = await open_viewer({ state });
        const reply = await viewer.insert({ requestId: 'ins' });
        await viewer.settle('ins', true);
        const appended = await viewer.append('app', 1) as {
            rowIds?: string[];
            formatTemplate?: { id: string };
            appendBasis?: unknown;
        };
        await viewer.settle('app', true);
        const ins = inserted(reply.rowIds![0]!, reply.formatTemplate!.id, 1, {
            cells: { 1: { value: 'new', valueEditOrder: 1 } },
        } as never);
        const app = {
            id: appended.rowIds![0]!,
            cells: { 0: { value: 'tail', valueEditOrder: 2 } },
            formatTemplateId: appended.formatTemplate!.id,
            createdOrder: 2,
        };
        const templates = [reply.formatTemplate, appended.formatTemplate]
            .filter((template, index, all) => all.findIndex((other) => other!.id === template!.id) === index);
        // c moved to the top, then a, the inserted row, and b deleted after it.
        const changes: Partial<WorksheetPendingEdits> = {
            formatTemplates: templates as never,
            appendedRows: [ins, app] as never,
            appendBasis: appended.appendBasis as never,
            rowLayout: {
                runs: [
                    { kind: 'source', start: 2, count: 1 },
                    { kind: 'source', start: 0, count: 1 },
                    { kind: 'pending', ids: [ins.id] },
                    { kind: 'source', start: 1, count: 1 },
                ],
                removedSourceRows: [{ start: 1, count: 1 }],
                discardedPendingRows: [],
            },
            structuralBasis: reply.structuralBasis!,
        };
        expect(await viewer.publish(changes)).toBe(true);
        const result = await viewer.save(changes);
        expect(result).toMatchObject({
            success: true,
            receipt: {
                appendedRows: [{ pendingRowId: app.id, sourceRow: 3 }],
                structure: [{
                    rowRuns: [{ from: 0, count: 1, to: 1 }, { from: 2, count: 1, to: 0 }],
                    removedRows: [{ start: 1, count: 1 }],
                    insertedRows: [{ pendingRowId: ins.id, sourceRow: 2 }],
                }],
            },
        });
        expect(dec.decode(viewer.file.bytes)).toBe('h1,h2\nc,3\na,1\n,new\ntail,\n');
        await vi.waitFor(() => expect(viewer.durable().pendingEdits).toBeUndefined());
        expect(viewer.durable().cellHighlights?.sheets[0]?.cells).toEqual({ '1:0': 'green', '0:1': 'yellow' });
        expect(viewer.durable().rowHeights?.[0]).toEqual({ 1: 20, 0: 22 });
        expect(viewer.durable().structuralRekeyIntent).toBeUndefined();
        await viewer.dispose();
    });
});
