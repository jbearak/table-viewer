// Structural save through the controller (row and column structure design,
// delivery step 5): the save gate, the Structural Basis check before planning,
// the rekey intent sequence with a stop after each numbered step, write
// failures, recovery and its unresolved choices, and reconciliation of a
// layout with external changes.
import { createHash } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type * as vscode from 'vscode';
import {
    attach_viewer,
    csv_table_profile,
    simulate_process_restart_for_tests,
} from '../viewer-controller';
import { with_in_memory_authority_transactions } from '../state-authority';
import {
    transform_schema_for_sheet,
    type PerFileState,
    type StructuralRekeyIntent,
    type WorksheetPendingEdits,
} from '../types';
import type { StructuralBasis } from '../pending-changes';
import { versioned_state_store } from './helpers/versioned-state-store';
import * as vscode_mock from './mocks/vscode';
import { fake_viewer_host } from './mocks/host-ports';

const enc = new TextEncoder();
const dec = new TextDecoder();
// One header and three body rows: canonical source rows 0-2, one column.
const BYTES = enc.encode('h\na\nb\nc\n');
const SAVED = enc.encode('h\na\nc\n');
const FILE = '/tmp/structural-save-host.csv';
const SCHEMA = transform_schema_for_sheet({ name: 'Sheet1', columnCount: 1, columnNames: ['h'] } as never);

const hex = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');

function basis_of(bytes: Uint8Array, rows: number): StructuralBasis {
    return {
        kind: 'delimited',
        byteLength: bytes.byteLength,
        digest: hex(bytes),
        sourceRowCount: rows,
        sourceColumnCount: 1,
    };
}

const BASIS = basis_of(BYTES, 3);

/** Source row 1 (`b`) removed. */
const REMOVAL_LAYOUT = {
    runs: [{ kind: 'source' as const, start: 0, count: 3 }],
    removedSourceRows: [{ start: 1, count: 1 }],
    discardedPendingRows: [],
};

const REMOVAL: Partial<WorksheetPendingEdits> = { rowLayout: REMOVAL_LAYOUT, structuralBasis: BASIS };

/** View state keyed to source rows 0-2. */
const VIEW_STATE: PerFileState = {
    cellHighlights: {
        sourceDigest: hex(BYTES),
        sheets: [{ schema: SCHEMA, cells: { '0:0': 'yellow', '1:0': 'green', '2:0': 'blue' } }],
    },
    rowHeights: [{ 1: 31, 2: 32 }],
    columnWidths: [{ 0: 120 }],
    transforms: [{ sort: [], filters: [], hiddenRows: [2], schema: SCHEMA }],
};

function slot(fields: Partial<WorksheetPendingEdits>): PerFileState['pendingEdits'] {
    return [{ sheetName: 'Sheet1', cells: {}, ...fields }];
}

afterEach(() => {
    for (const panel of vscode_mock.__getPanels()) panel.dispose();
    vi.restoreAllMocks();
    vscode_mock.__reset();
    simulate_process_restart_for_tests();
});

type Message = { type?: string } & Record<string, unknown>;

/** The file on disk, shared by every controller a test opens. */
function disk(initial: Uint8Array) {
    const file = {
        bytes: initial,
        mtime: 1,
        /** Return a promise that never settles from the next matching call. */
        hang_stat_at: undefined as number | undefined,
        /** Make the matching stat call throw, or report a different file. */
        fail_stat_at: undefined as { readonly at: number; readonly kind: 'throw' | 'changed' } | undefined,
        stat_calls: 0,
        hung: false,
        write: undefined as ((content: Uint8Array) => Promise<void>) | undefined,
        writes: [] as Uint8Array[],
    };
    const install = () => {
        vscode_mock.__setStatImplementation(async () => {
            file.stat_calls += 1;
            if (file.hang_stat_at !== undefined && file.stat_calls >= file.hang_stat_at) {
                file.hung = true;
                return new Promise<never>(() => {});
            }
            if (file.fail_stat_at?.at === file.stat_calls) {
                if (file.fail_stat_at.kind === 'throw') throw new Error('EBUSY');
                return { size: file.bytes.length, mtime: file.mtime + 100 };
            }
            return { size: file.bytes.length, mtime: file.mtime };
        });
        vscode_mock.__setReadFileImplementation(async () => file.bytes);
        vscode_mock.__setWriteFileImplementation(async (_uri, content) => {
            file.writes.push(content);
            if (file.write) return file.write(content);
            file.bytes = content;
            file.mtime += 1;
        });
    };
    return { file, install };
}

async function open_viewer(options: {
    readonly state: ReturnType<typeof versioned_state_store>;
    readonly disk: ReturnType<typeof disk>;
    readonly structuralEditingEnabled?: boolean;
    readonly path?: string;
    readonly requestEdit?: boolean;
    readonly structuralSaveLeaseMs?: number;
    /** Runs before every durable state read, so a test can pause one. */
    readonly beforeRead?: () => Promise<void>;
}) {
    options.disk.install();
    const path = options.path ?? FILE;
    const panel = vscode_mock.window.createWebviewPanel('tableViewer.editor', 'table');
    const controller = attach_viewer(
        panel as unknown as Parameters<typeof attach_viewer>[0],
        vscode_mock.Uri.file(path) as unknown as vscode.Uri,
        with_in_memory_authority_transactions(options.beforeRead === undefined
            ? options.state.store
            : {
                ...options.state.store,
                read: async (file_path) => {
                    await options.beforeRead!();
                    return options.state.store.read(file_path);
                },
            }),
        csv_table_profile(),
        fake_viewer_host,
        {
            structuralEditingEnabled: options.structuralEditingEnabled ?? true,
            ...(options.structuralSaveLeaseMs === undefined
                ? {}
                : { structuralSaveLeaseMs: options.structuralSaveLeaseMs }),
        },
    );
    panel.onDidDispose(() => controller.dispose());
    const warning = vi.spyOn(vscode_mock.window, 'showWarningMessage');
    warning.mockClear();
    await panel.__receive({ type: 'ready', structuralLayout: 1 });
    if (options.requestEdit !== false) {
        await panel.__receive({ type: 'requestEditSession', requestId: 'edit' });
    }
    await controller.drain();
    const messages = () => panel.__messages as Message[];
    const session = () => [...messages()].reverse().find((message) =>
        message.type === 'editSessionResult') as {
        granted: boolean;
        editSessionId?: string;
    } | undefined;
    const last = <T,>(type: string) => [...messages()].reverse().find((message) => message.type === type) as T;
    return {
        panel,
        controller,
        warning,
        messages,
        session,
        last,
        durable: () => options.state.get_state(path) as PerFileState,
        /**
         * Send a save of `structural`. Not awaited: a test that stops the save
         * part-way leaves its handler pending forever.
         */
        send_save(structural: Partial<WorksheetPendingEdits>, cells: Record<string, unknown> = {}): Promise<void> {
            return panel.__receive({
                type: 'saveCsv',
                operation: {
                    editSessionId: session()!.editSessionId!,
                    saveRequestId: `save-${Math.random()}`,
                    worksheets: [{
                        sheetIndex: 0,
                        sheetName: 'Sheet1',
                        edits: Object.fromEntries(Object.entries(cells).map(([key, value]) =>
                            [key, (value as { value: string }).value])),
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
        async save(structural: Partial<WorksheetPendingEdits>, cells: Record<string, unknown> = {}) {
            await this.send_save(structural, cells);
            await controller.drain();
            return last<{ success: boolean; receipt?: unknown; rejection?: unknown }>('saveResult');
        },
        async dispose() {
            panel.dispose();
        },
    };
}

function store_with(state: PerFileState) {
    return versioned_state_store({ ...VIEW_STATE, ...state });
}

describe('saving a row removal', () => {
    it('writes the live layout, rekeys view state, retires the payload, and clears the intent', async () => {
        const drive = disk(BYTES);
        const state = store_with({ pendingEdits: slot(REMOVAL) });
        const viewer = await open_viewer({ state, disk: drive });
        expect(viewer.session()).toMatchObject({ granted: true });

        const result = await viewer.save(REMOVAL);
        expect(result).toMatchObject({
            success: true,
            receipt: {
                appendedRows: [],
                removedSourceRows: [],
                structure: [{
                    sheetIndex: 0,
                    sheetName: 'Sheet1',
                    rowRuns: [{ from: 0, count: 1, to: 0 }, { from: 2, count: 1, to: 1 }],
                    removedRows: [{ start: 1, count: 1 }],
                    columnMap: [0],
                    insertedRows: [],
                    insertedColumns: [],
                }],
            },
        });
        expect(dec.decode(drive.file.bytes)).toBe('h\na\nc\n');
        await vi.waitFor(() => expect(viewer.durable().pendingEdits).toBeUndefined());
        const durable = viewer.durable();
        expect(durable.structuralRekeyIntent).toBeUndefined();
        expect(durable.cellHighlights?.sheets[0]?.cells).toEqual({ '0:0': 'yellow', '1:0': 'blue' });
        expect(durable.cellHighlights?.sourceDigest).toBe(hex(SAVED));
        expect(durable.rowHeights?.[0]).toEqual({ 1: 32 });
        expect(durable.transforms?.[0]).toMatchObject({ hiddenRows: [1], schema: SCHEMA });
        expect(durable.columnWidths?.[0]).toEqual({ 0: 120 });
        await viewer.dispose();
    });

    it('refuses with the flag off', async () => {
        const off = await open_viewer({
            state: store_with({ pendingEdits: slot(REMOVAL) }),
            disk: disk(BYTES),
            structuralEditingEnabled: false,
        });
        const write = vi.spyOn(vscode_mock.workspace.fs, 'writeFile');
        expect(await off.save(REMOVAL)).toMatchObject({ success: false });
        expect(off.warning).toHaveBeenCalledWith(
            'Saving inserted, deleted, or moved rows and columns is not available in this version.');
        expect(write).not.toHaveBeenCalled();
        await off.dispose();

        // An `.xlsx` path is let through the gate (delivery step 9), and its
        // Structural Basis is the package's: delimited bytes behind an
        // `.xlsx` path have none, so the save is refused before planning.
        const xlsx = await open_viewer({
            state: versioned_state_store({ pendingEdits: slot(REMOVAL) }),
            disk: disk(BYTES),
            path: '/tmp/structural-save-host.xlsx',
        });
        expect(xlsx.session()).toMatchObject({ granted: true });
        expect(await xlsx.save(REMOVAL)).toMatchObject({
            success: false,
            rejection: { reason: 'structuralConflict', structuralReason: 'structuralBasisChanged' },
        });
        expect(write).not.toHaveBeenCalled();
        await xlsx.dispose();
    });

    it('refuses a save whose Structural Basis no longer matches the verified file', async () => {
        const drive = disk(enc.encode('h\na\nX\nc\n'));
        const viewer = await open_viewer({
            state: store_with({ pendingEdits: slot(REMOVAL) }),
            disk: drive,
        });
        // Loading the changed file recorded the conflict before any save.
        expect(viewer.durable().pendingEdits?.[0]?.conflicts).toEqual([{
            reason: 'structuralBasisChanged',
            pendingRowIds: [],
            tailRemovalIds: [],
        }]);
        expect(await viewer.save(REMOVAL)).toMatchObject({
            success: false,
            rejection: { reason: 'structuralConflict', structuralReason: 'structuralBasisChanged' },
        });
        expect(drive.file.writes).toHaveLength(0);
        await viewer.dispose();
    });
});

describe('a deletion recorded through the snapshot basis', () => {
    // End to end through the webview-facing path: no hand-built basis. The
    // webview store records the basis the snapshot's structural-editing
    // capability reports, publishes the layout with it, and saves it.
    it('publishes, saves without a conflict, and removes the row', async () => {
        const drive = disk(BYTES);
        const viewer = await open_viewer({ state: versioned_state_store({}), disk: drive });
        const snapshot = viewer.last<{
            snapshot: {
                sourceGeneration: number;
                capabilities: { structuralEditing?: { sheets: { basis?: StructuralBasis }[] } };
            };
        }>('workbookSnapshot').snapshot;
        const basis = snapshot.capabilities.structuralEditing?.sheets[0]?.basis;
        expect(basis).toBeDefined();
        const changes = {
            formatTemplates: [],
            appendedRows: [],
            tailRemovals: [],
            conflicts: [],
            rowLayout: REMOVAL_LAYOUT,
            structuralBasis: basis!,
        };
        await viewer.panel.__receive({
            type: 'pendingChangesChanged',
            editSessionId: viewer.session()!.editSessionId!,
            sequence: 1,
            sourceGeneration: snapshot.sourceGeneration,
            changes: { sheetIndex: 0, sheetName: 'Sheet1', cells: {}, ...changes },
        });
        await viewer.controller.drain();
        expect(viewer.messages().some((message) =>
            message.type === 'pendingChangesAcknowledged' && message.sequence === 1)).toBe(true);
        expect(viewer.durable().pendingEdits?.[0]?.conflicts ?? []).toEqual([]);

        const result = await viewer.save(changes);
        expect(result).toMatchObject({ success: true });
        expect(result.rejection).toBeUndefined();
        expect(dec.decode(drive.file.bytes)).toBe('h\na\nc\n');
        await vi.waitFor(() => expect(viewer.durable().pendingEdits).toBeUndefined());
        await viewer.dispose();
    });
});

describe('external changes to a restructured worksheet', () => {
    it('rebases the layout over rows appended on disk', async () => {
        const drive = disk(BYTES);
        const state = store_with({ pendingEdits: slot(REMOVAL) });
        const viewer = await open_viewer({ state, disk: drive });
        const grown = enc.encode('h\na\nb\nc\nd\ne\n');
        drive.file.bytes = grown;
        drive.file.mtime = 2;
        await vscode_mock.__getWatchers()[0]!.__fireChange();
        await viewer.controller.drain();
        await vi.waitFor(() => expect(viewer.durable().pendingEdits?.[0]?.structuralBasis)
            .toEqual(basis_of(grown, 5)));
        expect(viewer.durable().pendingEdits?.[0]).toMatchObject({
            rowLayout: {
                runs: [{ kind: 'source', start: 0, count: 5 }],
                removedSourceRows: [{ start: 1, count: 1 }],
            },
            conflicts: [],
        });
        // The rebased payload saves against the grown file.
        const result = await viewer.save({
            rowLayout: { ...REMOVAL_LAYOUT, runs: [{ kind: 'source', start: 0, count: 5 }] },
            structuralBasis: basis_of(grown, 5),
        });
        expect(result).toMatchObject({ success: true });
        expect(dec.decode(drive.file.bytes)).toBe('h\na\nc\nd\ne\n');
        await viewer.dispose();
    });

    it('records a structuralBasisChanged conflict for any other change', async () => {
        const drive = disk(BYTES);
        const viewer = await open_viewer({ state: store_with({ pendingEdits: slot(REMOVAL) }), disk: drive });
        drive.file.bytes = enc.encode('h\na\nb2\nc\nd\n');
        drive.file.mtime = 2;
        await vscode_mock.__getWatchers()[0]!.__fireChange();
        await viewer.controller.drain();
        await vi.waitFor(() => expect(viewer.durable().pendingEdits?.[0]?.conflicts)
            .toEqual([{ reason: 'structuralBasisChanged', pendingRowIds: [], tailRemovalIds: [] }]));
        expect(viewer.durable().pendingEdits?.[0]?.structuralBasis).toEqual(BASIS);
        await viewer.dispose();
    });

    it('drops a layout that holds only discarded tombstones', async () => {
        const drive = disk(BYTES);
        const tombstones = {
            runs: [
                { kind: 'source' as const, start: 0, count: 3 },
                { kind: 'pending' as const, ids: ['gone'] },
            ],
            removedSourceRows: [],
            discardedPendingRows: [{ id: 'gone', createdOrder: 1 }],
        };
        const viewer = await open_viewer({
            state: store_with({ pendingEdits: slot({ cells: { '0:0': { value: 'x', base: 'a' } }, rowLayout: tombstones }) }),
            disk: drive,
        });
        expect(viewer.durable().pendingEdits?.[0]?.rowLayout).toEqual(tombstones);
        drive.file.bytes = enc.encode('h\na\nb\nc\nd\n');
        drive.file.mtime = 2;
        await vscode_mock.__getWatchers()[0]!.__fireChange();
        await viewer.controller.drain();
        await vi.waitFor(() => expect(viewer.durable().pendingEdits?.[0]?.rowLayout).toBeUndefined());
        expect(viewer.durable().pendingEdits?.[0]?.cells).toEqual({ '0:0': { value: 'x', base: 'a' } });
        await viewer.dispose();
    });
});

describe('the rekey intent, stopped after each step', () => {
    /** Reopen the file in a fresh controller, as a new process would after a stop. */
    async function reopen(state: ReturnType<typeof versioned_state_store>, drive: ReturnType<typeof disk>) {
        simulate_process_restart_for_tests();
        drive.file.hang_stat_at = undefined;
        drive.file.write = undefined;
        return open_viewer({ state, disk: drive });
    }

    it.each([
        ['1 (payload persisted)', 1],
        ['3 (intent stored, before the final stat)', 3],
    ])('reloads after step %s with the payload kept and Save working', async (_label, stat_index) => {
        const drive = disk(BYTES);
        const state = store_with({ pendingEdits: slot(REMOVAL) });
        const first = await open_viewer({ state, disk: drive });
        drive.file.stat_calls = 0;
        drive.file.hang_stat_at = stat_index;
        void first.send_save(REMOVAL);
        await vi.waitFor(() => expect(drive.file.hung).toBe(true));
        if (stat_index === 3) {
            expect(state.get_state(FILE).structuralRekeyIntent).toMatchObject({
                beforeDigest: hex(BYTES),
                afterDigest: hex(SAVED),
                worksheets: [{ sheetIndex: 0, sheetName: 'Sheet1' }],
            });
        } else {
            expect(state.get_state(FILE).structuralRekeyIntent).toBeUndefined();
        }
        expect(drive.file.writes).toHaveLength(0);
        await first.dispose();

        const second = await reopen(state, drive);
        expect(second.durable().structuralRekeyIntent).toBeUndefined();
        expect(second.durable().pendingEdits?.[0]).toMatchObject(REMOVAL);
        expect(second.durable().cellHighlights?.sheets[0]?.cells).toEqual(VIEW_STATE.cellHighlights!.sheets[0]!.cells);
        expect(await second.save(REMOVAL)).toMatchObject({ success: true });
        expect(dec.decode(drive.file.bytes)).toBe('h\na\nc\n');
        await vi.waitFor(() => expect(second.durable().pendingEdits).toBeUndefined());
        expect(second.durable().cellHighlights?.sheets[0]?.cells).toEqual({ '0:0': 'yellow', '1:0': 'blue' });
        await second.dispose();
    });

    it('reloads after step 4 (written, before the post-write transition) and applies the intent', async () => {
        const drive = disk(BYTES);
        const state = store_with({ pendingEdits: slot(REMOVAL) });
        const first = await open_viewer({ state, disk: drive });
        drive.file.write = (content) => {
            drive.file.bytes = content;
            drive.file.mtime += 1;
            return new Promise<never>(() => {});
        };
        void first.send_save(REMOVAL);
        await vi.waitFor(() => expect(drive.file.writes).toHaveLength(1));
        expect(state.get_state(FILE).structuralRekeyIntent).toBeDefined();
        await first.dispose();

        const second = await reopen(state, drive);
        const durable = second.durable();
        expect(durable.structuralRekeyIntent).toBeUndefined();
        expect(durable.pendingEdits).toBeUndefined();
        expect(durable.cellHighlights?.sheets[0]?.cells).toEqual({ '0:0': 'yellow', '1:0': 'blue' });
        expect(durable.rowHeights?.[0]).toEqual({ 1: 32 });
        // A later Save never re-applies the saved layout to the restructured file.
        expect(await second.save({})).toMatchObject({ success: true });
        expect(dec.decode(drive.file.bytes)).toBe('h\na\nc\n');
        await second.dispose();
    });
});

describe('known aborts before the write', () => {
    it.each(['throw', 'changed'] as const)(
        'clear the intent and keep the payload when the final stat %s',
        async (kind) => {
            const drive = disk(BYTES);
            const state = store_with({ pendingEdits: slot(REMOVAL) });
            const viewer = await open_viewer({ state, disk: drive });
            drive.file.stat_calls = 0;
            // current, verified, final: the third stat is the one before the write.
            drive.file.fail_stat_at = { at: 3, kind };
            expect(await viewer.save(REMOVAL)).toMatchObject({ success: false });
            expect(drive.file.writes).toHaveLength(0);
            expect(viewer.durable().structuralRekeyIntent).toBeUndefined();
            expect(viewer.durable().pendingEdits?.[0]).toMatchObject(REMOVAL);
            await viewer.dispose();
        },
    );
});

describe('a post-write transition that fails', () => {
    it('recovers the stored intent and reports the save as succeeded, with its receipt', async () => {
        const drive = disk(BYTES);
        const state = store_with({ pendingEdits: slot(REMOVAL) });
        const viewer = await open_viewer({ state, disk: drive });
        // The first state write after the file is written (the post-write
        // transition) fails; the recovery's own write then succeeds.
        const compare_and_set = state.store.compare_and_set.bind(state.store);
        let failed = false;
        vi.spyOn(state.store, 'compare_and_set').mockImplementation(async (...args) => {
            if (!failed && drive.file.writes.length > 0) {
                failed = true;
                throw new Error('state write failed');
            }
            return compare_and_set(...args);
        });
        const result = await viewer.save(REMOVAL);
        expect(failed).toBe(true);
        expect(result).toMatchObject({
            success: true,
            lifecycle: { state: 'succeeded' },
            receipt: { structure: [{ removedRows: [{ start: 1, count: 1 }] }] },
        });
        expect(dec.decode(drive.file.bytes)).toBe('h\na\nc\n');
        await vi.waitFor(() => expect(viewer.durable().pendingEdits).toBeUndefined());
        expect(viewer.durable().structuralRekeyIntent).toBeUndefined();
        expect(viewer.durable().cellHighlights?.sheets[0]?.cells).toEqual({ '0:0': 'yellow', '1:0': 'blue' });
        await viewer.dispose();
    });
});

describe('a structural write that fails', () => {
    it('clears the intent and keeps the payload when nothing was written', async () => {
        const drive = disk(BYTES);
        const state = store_with({ pendingEdits: slot(REMOVAL) });
        const viewer = await open_viewer({ state, disk: drive });
        drive.file.write = async () => { throw new Error('disk full'); };
        expect(await viewer.save(REMOVAL)).toMatchObject({ success: false });
        expect(viewer.durable().structuralRekeyIntent).toBeUndefined();
        expect(viewer.durable().pendingEdits?.[0]).toMatchObject(REMOVAL);
        drive.file.write = undefined;
        expect(await viewer.save(REMOVAL)).toMatchObject({ success: true });
        expect(dec.decode(drive.file.bytes)).toBe('h\na\nc\n');
        await viewer.dispose();
    });

    it('keeps the intent unresolved when the file changed, and refuses editing', async () => {
        const drive = disk(BYTES);
        const state = store_with({ pendingEdits: slot(REMOVAL) });
        const viewer = await open_viewer({ state, disk: drive });
        drive.file.write = async () => {
            drive.file.bytes = enc.encode('h\na\n');
            drive.file.mtime += 1;
            throw new Error('interrupted');
        };
        expect(await viewer.save(REMOVAL)).toMatchObject({ success: false });
        await vi.waitFor(() => expect(viewer.last<{ notice: unknown }>('structuralSaveUnresolved')?.notice)
            .toMatchObject({
                message: "Table Viewer can't tell whether your last save of structural-save-host.csv finished, "
                    + 'because the file has changed since.',
                suggestion: 'notFinished',
            }));
        expect(viewer.durable().structuralRekeyIntent).toBeDefined();
        expect(viewer.durable().pendingEdits?.[0]).toMatchObject(REMOVAL);
        // A second save would repeat the changes the first may have written.
        drive.file.write = undefined;
        expect(await viewer.save(REMOVAL)).toMatchObject({ success: false });
        expect(viewer.warning).toHaveBeenCalledWith(
            'Choose whether your last save finished before editing this file.');
        expect(dec.decode(drive.file.bytes)).toBe('h\na\n');
        await viewer.dispose();
    });
});

describe('an unresolved rekey intent', () => {
    const INTENT: StructuralRekeyIntent = {
        saveId: 'interrupted',
        beforeDigest: hex(enc.encode('h\na\nb\nc\nzzz\n')),
        afterDigest: hex(enc.encode('h\na\nzzz\n')),
        worksheets: [{ sheetIndex: 0, sheetName: 'Sheet1', acceptedSequence: 1 }],
        receipt: {
            appendedRows: [],
            removedSourceRows: [],
            structure: [{
                sheetIndex: 0,
                sheetName: 'Sheet1',
                rowRuns: [{ from: 0, count: 1, to: 0 }, { from: 2, count: 1, to: 1 }],
                removedRows: [{ start: 1, count: 1 }],
                columnMap: [0],
                insertedRows: [],
                insertedColumns: [],
            }],
        },
    };

    async function open_unresolved(file: Uint8Array) {
        const drive = disk(file);
        const state = store_with({ pendingEdits: slot(REMOVAL), structuralRekeyIntent: INTENT });
        const viewer = await open_viewer({ state, disk: drive });
        return { drive, state, viewer };
    }

    it('shows the notice with the shape hint, refuses editing, and hides keyed view state', async () => {
        // Two body rows: the shape the save would have written.
        const { viewer } = await open_unresolved(enc.encode('h\na\nc\n'));
        expect(viewer.last<{ notice: unknown }>('structuralSaveUnresolved').notice).toMatchObject({
            saveId: 'interrupted',
            suggestion: 'finished',
        });
        expect(viewer.session()).toMatchObject({ granted: false });
        expect(viewer.warning).toHaveBeenCalledWith(
            'Choose whether your last save finished before editing this file.');
        const snapshot = viewer.last<{ snapshot: { state: PerFileState } }>('workbookSnapshot').snapshot;
        expect(snapshot.state.cellHighlights?.sheets[0]).toBeUndefined();
        expect(snapshot.state.columnWidths?.[0]).toBeUndefined();
        expect(snapshot.state.transforms?.[0]?.hiddenRows ?? []).toEqual([]);
        // Durable state keeps every annotation until the user chooses.
        expect(viewer.durable().cellHighlights?.sheets[0]?.cells).toEqual(VIEW_STATE.cellHighlights!.sheets[0]!.cells);
        await viewer.dispose();
    });

    it('installs no durable hidden rows on an affected sheet as view state', async () => {
        // Three body rows, so the durable hiddenRows [2] would be in range.
        const { viewer } = await open_unresolved(BYTES);
        // A reloaded renderer: the ready path reconciles installed transforms
        // with durable state.
        await viewer.panel.__receive({ type: 'ready', structuralLayout: 1 });
        await viewer.controller.drain();
        const snapshot = viewer.last<{ snapshot: { generation: number } }>('workbookSnapshot').snapshot;
        await viewer.panel.__receive({
            type: 'requestRows',
            sheetIndex: 0,
            startRow: 0,
            count: 3,
            requestId: 'rows',
            generation: snapshot.generation,
        });
        await viewer.controller.drain();
        expect(viewer.last<{ sourceRows: number[] }>('rowData').sourceRows).toEqual([0, 1, 2]);
        expect(viewer.durable().transforms?.[0]?.hiddenRows).toEqual([2]);
        await viewer.dispose();
    });

    it('refuses writes of source-keyed annotations on an affected sheet', async () => {
        const { viewer, state } = await open_unresolved(BYTES);
        const snapshot = viewer.last<{
            snapshot: { generation: number; sourceGeneration: number; identity: unknown; state: PerFileState };
        }>('workbookSnapshot').snapshot;
        const before = structuredClone(viewer.durable());
        const stamp = { generation: snapshot.generation, sourceGeneration: snapshot.sourceGeneration };

        await viewer.panel.__receive({
            type: 'applyCellHighlights',
            sheetIndex: 0,
            sheetName: 'Sheet1',
            selection: { displayRows: [{ start: 0, end: 0 }], sourceColumns: [0] },
            mutation: { type: 'set', color: 'pink' },
            requestId: 'highlight',
            snapshotIdentity: snapshot.identity,
            ...stamp,
        });
        await viewer.controller.drain();
        expect(viewer.last<{ requestId: string; error?: string }>('cellHighlightsChanged')).toMatchObject({
            requestId: 'highlight',
            error: 'Choose whether your last save finished before editing this file.',
        });
        // The refusal hands back what the panel may show, not the withheld highlights.
        expect(viewer.last<{ state?: PerFileState['cellHighlights'] }>('cellHighlightsChanged').state?.sheets[0])
            .toBeUndefined();

        await viewer.panel.__receive({
            type: 'setRowHeights', sheetIndex: 0, rows: [{ start: 0, end: 0 }], height: 50, requestId: 'resize', ...stamp,
        });
        await viewer.controller.drain();
        expect(viewer.last<{ requestId: string; applied: boolean }>('rowHeightsChanged'))
            .toMatchObject({ requestId: 'resize', applied: false });

        await viewer.panel.__receive({
            type: 'setTransform',
            sheetIndex: 0,
            state: { sort: [], filters: [], hiddenRows: [0], schema: SCHEMA },
            requestId: 'hide',
            intent: 'user',
            ...stamp,
        });
        await viewer.controller.drain();
        expect(viewer.last<{ requestId: string }>('transformRefused')).toMatchObject({ requestId: 'hide' });

        await viewer.panel.__receive({
            type: 'stateChanged',
            state: { ...snapshot.state, columnWidths: [{ 0: 300 }] },
            sourceGeneration: snapshot.sourceGeneration,
            snapshotIdentity: snapshot.identity,
        });
        await viewer.controller.drain();

        const after = state.get_state(FILE) as PerFileState;
        expect(after.cellHighlights).toEqual(before.cellHighlights);
        expect(after.rowHeights).toEqual(before.rowHeights);
        expect(after.transforms).toEqual(before.transforms);
        expect(after.columnWidths).toEqual(before.columnWidths);
        await viewer.dispose();
    });

    it.each(['finished', 'notFinished'] as const)(
        'keeps column widths through a resize during the notice, its answer (%s), and a stale write',
        async (choice) => {
            const { viewer, state } = await open_unresolved(enc.encode('h\na\nc\n'));
            const snapshot = viewer.last<{
                snapshot: { sourceGeneration: number; identity: unknown; state: PerFileState };
            }>('workbookSnapshot').snapshot;
            const resize = () => viewer.panel.__receive({
                type: 'stateChanged',
                state: { ...snapshot.state, columnWidths: [{ 0: 300 }] },
                sourceGeneration: snapshot.sourceGeneration,
                snapshotIdentity: snapshot.identity,
            });
            const widths = () => (state.get_state(FILE) as PerFileState).columnWidths;
            // The panel shows the sheet without widths; a resize there names
            // a column the receipt may renumber, so the host keeps its own.
            await resize();
            await viewer.controller.drain();
            expect(widths()).toEqual([{ 0: 120 }]);
            const snapshots = () => viewer.messages().filter((message) => message.type === 'workbookSnapshot');
            const before = snapshots().length;
            await viewer.panel.__receive({ type: 'resolveStructuralSave', saveId: 'interrupted', choice });
            await viewer.controller.drain();
            expect(widths()).toEqual([{ 0: 120 }]);
            // The answer delivers a new snapshot with the widths, so the panel
            // replaces the width it showed during the notice.
            expect(snapshots().length).toBeGreaterThan(before);
            expect((snapshots().at(-1) as unknown as { snapshot: { state: PerFileState } })
                .snapshot.state.columnWidths?.[0]).toEqual({ 0: 120 });
            // A write still stamped with the notice's snapshot is dropped.
            await resize();
            await viewer.controller.drain();
            expect(widths()).toEqual([{ 0: 120 }]);
            await viewer.dispose();
        },
    );

    it('suggests "It didn\'t finish" when the shape does not match', async () => {
        const { viewer } = await open_unresolved(BYTES);
        // BYTES matches the payload's basis but neither intent digest.
        expect(viewer.last<{ notice: unknown }>('structuralSaveUnresolved').notice)
            .toMatchObject({ suggestion: 'notFinished' });
        await viewer.dispose();
    });

    it('"It finished" applies the intent and parks the payload', async () => {
        const { viewer } = await open_unresolved(enc.encode('h\na\nc\n'));
        await viewer.panel.__receive({ type: 'resolveStructuralSave', saveId: 'interrupted', choice: 'finished' });
        await viewer.controller.drain();
        const durable = viewer.durable();
        expect(durable.structuralRekeyIntent).toBeUndefined();
        expect(durable.cellHighlights?.sheets[0]?.cells).toEqual({ '0:0': 'yellow', '1:0': 'blue' });
        expect(durable.pendingEdits?.some((entry) => entry?.sheetName === '[Unconfirmed save] Sheet1')).toBe(true);
        expect(viewer.last<{ notice: unknown }>('structuralSaveUnresolved').notice).toBeNull();
        await viewer.dispose();
    });

    it('"It didn\'t finish" clears the intent and keeps the payload, which meets the basis check', async () => {
        const { viewer } = await open_unresolved(enc.encode('h\na\nc\n'));
        await viewer.panel.__receive({ type: 'resolveStructuralSave', saveId: 'interrupted', choice: 'notFinished' });
        await viewer.controller.drain();
        const durable = viewer.durable();
        expect(durable.structuralRekeyIntent).toBeUndefined();
        expect(durable.cellHighlights?.sheets[0]?.cells).toEqual(VIEW_STATE.cellHighlights!.sheets[0]!.cells);
        expect(durable.pendingEdits?.[0]).toMatchObject({
            ...REMOVAL,
            conflicts: [{ reason: 'structuralBasisChanged' }],
        });
        await viewer.dispose();
    });
});

describe('rekey intent ownership across processes', () => {
    const owned = (lease_expires_at_ms: number): StructuralRekeyIntent => ({
        saveId: 'elsewhere',
        beforeDigest: hex(BYTES),
        afterDigest: hex(SAVED),
        worksheets: [{ sheetIndex: 0, sheetName: 'Sheet1', acceptedSequence: 1 }],
        receipt: {
            appendedRows: [],
            removedSourceRows: [],
            structure: [{
                sheetIndex: 0,
                sheetName: 'Sheet1',
                rowRuns: [{ from: 0, count: 1, to: 0 }, { from: 2, count: 1, to: 1 }],
                removedRows: [{ start: 1, count: 1 }],
                columnMap: [0],
                insertedRows: [],
                insertedColumns: [],
            }],
        },
        owner: { id: 'another-process', leaseExpiresAtMs: lease_expires_at_ms },
    });

    it('leaves a live intent another process owns alone, and blocks editing without a notice', async () => {
        // The file still has the bytes the save read: its owner has not written yet.
        const state = store_with({ pendingEdits: slot(REMOVAL), structuralRekeyIntent: owned(Date.now() + 60_000) });
        const viewer = await open_viewer({ state, disk: disk(BYTES) });
        expect(viewer.durable().structuralRekeyIntent?.saveId).toBe('elsewhere');
        expect(viewer.session()).toMatchObject({ granted: false });
        expect(viewer.warning).toHaveBeenCalledWith(
            'Another Table Viewer window is saving this file. Try again when it finishes.');
        expect(viewer.last<{ notice: unknown } | undefined>('structuralSaveUnresolved')?.notice ?? null).toBeNull();
        await viewer.dispose();
    });

    it('recovers the intent once its owner stops renewing the lease', async () => {
        const state = store_with({ pendingEdits: slot(REMOVAL), structuralRekeyIntent: owned(Date.now() + 300) });
        const viewer = await open_viewer({ state, disk: disk(BYTES), requestEdit: false });
        expect(viewer.durable().structuralRekeyIntent?.saveId).toBe('elsewhere');
        await vi.waitFor(() => expect(viewer.durable().structuralRekeyIntent).toBeUndefined(), { timeout: 3_000 });
        expect(viewer.durable().pendingEdits?.[0]).toMatchObject(REMOVAL);
        await viewer.dispose();
    });

    it('recovers an expired lease on load', async () => {
        const state = store_with({ pendingEdits: slot(REMOVAL), structuralRekeyIntent: owned(Date.now() - 1) });
        const viewer = await open_viewer({ state, disk: disk(SAVED) });
        expect(viewer.durable().structuralRekeyIntent).toBeUndefined();
        expect(viewer.durable().pendingEdits).toBeUndefined();
        expect(viewer.durable().cellHighlights?.sheets[0]?.cells).toEqual({ '0:0': 'yellow', '1:0': 'blue' });
        await viewer.dispose();
    });

    it('refuses a save that another process\'s live save started after load, keeping that save\'s payload', async () => {
        // Saves on one file are not serialized across processes: each host
        // has its own file coordinator. A second process starts a structural
        // save after this one loaded, so no load-time gate has seen it: it
        // has persisted its accepted payload (cell 0:0) and stored its intent.
        const drive = disk(BYTES);
        const state = store_with({ pendingEdits: slot(REMOVAL) });
        const viewer = await open_viewer({ state, disk: drive });
        expect(viewer.session()).toMatchObject({ granted: true });
        const first_payload = slot({ ...REMOVAL, cells: { '0:0': { value: 'first', base: 'a' } } });
        const current = state.get_state(FILE) as PerFileState;
        await state.store.compare_and_set(FILE, state.revision(FILE), {
            ...current,
            pendingEdits: first_payload,
            structuralRekeyIntent: owned(Date.now() + 60_000),
        });

        // This window saves a different payload (cell 2:0).
        expect(await viewer.save(REMOVAL, { '2:0': { value: 'second', base: 'c' } })).toMatchObject({ success: false });
        expect(viewer.warning).toHaveBeenCalledWith(
            'Another Table Viewer window is saving this file. Try again when it finishes.');
        expect(drive.file.writes).toHaveLength(0);
        expect(viewer.durable().structuralRekeyIntent?.saveId).toBe('elsewhere');
        expect(viewer.durable().pendingEdits).toEqual(first_payload);

        // The first save aborts before its write: it clears its own intent and
        // keeps its accepted payload, which this save never replaced.
        const aborted = state.get_state(FILE) as PerFileState;
        const { structuralRekeyIntent: _intent, ...rest } = aborted;
        await state.store.compare_and_set(FILE, state.revision(FILE), rest);
        expect((state.get_state(FILE) as PerFileState).pendingEdits?.[0]?.cells)
            .toEqual({ '0:0': { value: 'first', base: 'a' } });
        await viewer.dispose();
    });

    it('leaves no cleanup tombstone for a save closed while its refused payload write was pending', async () => {
        // The foreign save's accepted payload holds an edit this window's save
        // also carries, value for value: a tombstone for our never-persisted
        // save would strip it during failed-save cleanup.
        const drive = disk(BYTES);
        const state = store_with({ pendingEdits: slot(REMOVAL) });
        let pause_next_read = false;
        let paused = false;
        let release_read!: () => void;
        const viewer = await open_viewer({
            state,
            disk: drive,
            // Pause the payload compare-and-set's state read.
            beforeRead: async () => {
                if (!pause_next_read) return;
                pause_next_read = false;
                paused = true;
                await new Promise<void>((resolve) => { release_read = resolve; });
            },
        });
        const shared = { '0:0': { value: 'shared', base: 'a' } };
        const foreign_payload = slot({ ...REMOVAL, cells: shared });
        const current = state.get_state(FILE) as PerFileState;
        await state.store.compare_and_set(FILE, state.revision(FILE), {
            ...current,
            pendingEdits: foreign_payload,
            structuralRekeyIntent: owned(Date.now() + 60_000),
        });
        pause_next_read = true;
        void viewer.send_save(REMOVAL, shared);
        await vi.waitFor(() => expect(paused).toBe(true));
        // Close the viewer while the read is pending: the release decides
        // whether this save left a tombstone.
        viewer.panel.dispose();
        release_read();
        await viewer.controller.drain();
        await vi.waitFor(() => expect((state.get_state(FILE) as PerFileState).pendingEdits).toEqual(foreign_payload));
        // A fresh window's cleanup finds nothing of ours to strip.
        simulate_process_restart_for_tests();
        const reopened = await open_viewer({ state, disk: drive, requestEdit: false });
        expect((state.get_state(FILE) as PerFileState).pendingEdits?.[0]?.cells).toEqual(shared);
        await reopened.dispose();
    });

    it('rechecks a lapsing lease without refreshing while the owner keeps it alive', async () => {
        const state = store_with({ pendingEdits: slot(REMOVAL), structuralRekeyIntent: owned(Date.now() + 300) });
        const viewer = await open_viewer({ state, disk: disk(BYTES), requestEdit: false });
        // The owner renews before the recheck fires.
        const current = state.get_state(FILE) as PerFileState;
        await state.store.compare_and_set(FILE, state.revision(FILE), {
            ...current,
            structuralRekeyIntent: owned(Date.now() + 60_000),
        });
        const snapshots = () => viewer.messages().filter((message) => message.type === 'workbookSnapshot').length;
        const before = snapshots();
        const read = vi.spyOn(vscode_mock.workspace.fs, 'readFile');
        // The recheck reads the file once; poll for that, not for time.
        await vi.waitFor(() => expect(read).toHaveBeenCalled(), { timeout: 3_000 });
        await viewer.controller.drain();
        expect(snapshots()).toBe(before);
        expect(viewer.durable().structuralRekeyIntent?.saveId).toBe('elsewhere');
        await viewer.dispose();
    });

    it('renews its own lease while a save runs', async () => {
        const drive = disk(BYTES);
        const state = store_with({ pendingEdits: slot(REMOVAL) });
        const viewer = await open_viewer({ state, disk: drive, structuralSaveLeaseMs: 300 });
        drive.file.stat_calls = 0;
        drive.file.hang_stat_at = 3;
        void viewer.send_save(REMOVAL);
        await vi.waitFor(() => expect(drive.file.hung).toBe(true));
        const first = (state.get_state(FILE) as PerFileState).structuralRekeyIntent!.owner!.leaseExpiresAtMs;
        await vi.waitFor(() => expect((state.get_state(FILE) as PerFileState).structuralRekeyIntent?.owner
            ?.leaseExpiresAtMs).toBeGreaterThan(first), { timeout: 3_000 });
        await viewer.dispose();
    });
});

describe('a save outliving its panel', () => {
    it('keeps renewing its lease while the write is still pending', async () => {
        const drive = disk(BYTES);
        const state = store_with({ pendingEdits: slot(REMOVAL) });
        const viewer = await open_viewer({ state, disk: drive, structuralSaveLeaseMs: 300 });
        let finish_write!: () => void;
        drive.file.write = (content) => new Promise<void>((resolve) => {
            finish_write = () => {
                drive.file.bytes = content;
                drive.file.mtime += 1;
                resolve();
            };
        });
        void viewer.send_save(REMOVAL);
        await vi.waitFor(() => expect(drive.file.writes).toHaveLength(1));
        const owner = () => (state.get_state(FILE) as PerFileState).structuralRekeyIntent?.owner;
        const first = owner()!.leaseExpiresAtMs;
        viewer.panel.dispose();
        // Past the original expiry, the lease is still being renewed.
        await vi.waitFor(() => expect(owner()?.leaseExpiresAtMs).toBeGreaterThan(first + 300), { timeout: 3_000 });
        expect(owner()!.leaseExpiresAtMs).toBeGreaterThan(Date.now());
        finish_write();
        await viewer.controller.drain();
        // The write landed after the panel closed; the intent waits for the next load.
        expect(dec.decode(drive.file.bytes)).toBe('h\na\nc\n');
        expect((state.get_state(FILE) as PerFileState).structuralRekeyIntent?.afterDigest).toBe(hex(SAVED));
    });
});

describe('recovery after the write', () => {
    it('keeps the intent stored when the panel closes during the write', async () => {
        const drive = disk(BYTES);
        const state = store_with({ pendingEdits: slot(REMOVAL) });
        const viewer = await open_viewer({ state, disk: drive });
        drive.file.write = async (content) => {
            drive.file.bytes = content;
            drive.file.mtime += 1;
            viewer.panel.dispose();
        };
        void viewer.send_save(REMOVAL);
        await vi.waitFor(() => expect(drive.file.writes).toHaveLength(1));
        await viewer.controller.drain();
        // Nothing could rekey the closed panel's state, so nothing was retired.
        expect(viewer.durable().structuralRekeyIntent?.afterDigest).toBe(hex(SAVED));
        expect(viewer.durable().cellHighlights?.sheets[0]?.cells).toEqual(VIEW_STATE.cellHighlights!.sheets[0]!.cells);

        simulate_process_restart_for_tests();
        drive.file.write = undefined;
        const reopened = await open_viewer({ state, disk: drive });
        expect(reopened.durable().structuralRekeyIntent).toBeUndefined();
        expect(reopened.durable().pendingEdits).toBeUndefined();
        expect(reopened.durable().cellHighlights?.sheets[0]?.cells).toEqual({ '0:0': 'yellow', '1:0': 'blue' });
        await reopened.dispose();
    });

    it('reports a write that landed and then failed as the success it was', async () => {
        const drive = disk(BYTES);
        const state = store_with({ pendingEdits: slot(REMOVAL) });
        const viewer = await open_viewer({ state, disk: drive });
        drive.file.write = async (content) => {
            drive.file.bytes = content;
            drive.file.mtime += 1;
            throw new Error('EIO after write');
        };
        const result = await viewer.save(REMOVAL);
        expect(result).toMatchObject({ success: true, receipt: { structure: [{ removedRows: [{ start: 1, count: 1 }] }] } });
        expect(viewer.durable().structuralRekeyIntent).toBeUndefined();
        expect(viewer.durable().cellHighlights?.sheets[0]?.cells).toEqual({ '0:0': 'yellow', '1:0': 'blue' });
        await viewer.dispose();
    });

    it('reports the success once even when a second resolution would fail', async () => {
        const drive = disk(BYTES);
        const state = store_with({ pendingEdits: slot(REMOVAL) });
        const viewer = await open_viewer({ state, disk: drive });
        drive.file.write = async (content) => {
            drive.file.bytes = content;
            drive.file.mtime += 1;
            // The failed write's recovery reads the file once and applies the
            // intent. Any later read fails, as a second resolution would.
            let reads = 0;
            vscode_mock.__setReadFileImplementation(async () => {
                reads += 1;
                if (reads > 1) throw new Error('EIO on reread');
                return drive.file.bytes;
            });
            throw new Error('EIO after write');
        };
        const result = await viewer.save(REMOVAL);
        expect(result).toMatchObject({ success: true, receipt: { structure: [{ removedRows: [{ start: 1, count: 1 }] }] } });
        expect(viewer.durable().structuralRekeyIntent).toBeUndefined();
        expect(viewer.durable().cellHighlights?.sheets[0]?.cells).toEqual({ '0:0': 'yellow', '1:0': 'blue' });
        await viewer.dispose();
    });

    it('re-reads the file and leaves the intent unresolved when it changed again', async () => {
        const drive = disk(BYTES);
        const state = store_with({ pendingEdits: slot(REMOVAL) });
        const viewer = await open_viewer({ state, disk: drive });
        const compare_and_set = state.store.compare_and_set.bind(state.store);
        let failed = false;
        vi.spyOn(state.store, 'compare_and_set').mockImplementation(async (...args) => {
            if (!failed && drive.file.writes.length > 0) {
                failed = true;
                // Someone else writes the file between our write and recovery.
                drive.file.bytes = enc.encode('h\nsomeone else\n');
                drive.file.mtime += 1;
                throw new Error('state write failed');
            }
            return compare_and_set(...args);
        });
        expect(await viewer.save(REMOVAL)).toMatchObject({ success: false });
        expect(viewer.durable().structuralRekeyIntent?.afterDigest).toBe(hex(SAVED));
        expect(viewer.durable().cellHighlights?.sheets[0]?.cells).toEqual(VIEW_STATE.cellHighlights!.sheets[0]!.cells);
        await viewer.dispose();
    });
});

describe('discarding row and column changes after a basis conflict', () => {
    it('publishes the discard, which clears the worksheet-level conflict', async () => {
        const drive = disk(enc.encode('h\na\nX\nc\n'));
        const viewer = await open_viewer({ state: store_with({ pendingEdits: slot(REMOVAL) }), disk: drive });
        expect(viewer.durable().pendingEdits?.[0]?.conflicts).toHaveLength(1);
        const snapshot = viewer.last<{ snapshot: { sourceGeneration: number } }>('workbookSnapshot').snapshot;
        await viewer.panel.__receive({
            type: 'pendingChangesChanged',
            editSessionId: viewer.session()!.editSessionId!,
            sequence: 1,
            sourceGeneration: snapshot.sourceGeneration,
            changes: {
                sheetIndex: 0,
                sheetName: 'Sheet1',
                cells: { '0:0': { value: 'kept', base: 'a' } },
                formatTemplates: [],
                appendedRows: [],
                tailRemovals: [],
                conflicts: [],
            },
        });
        await viewer.controller.drain();
        expect(viewer.messages().some((message) =>
            message.type === 'pendingChangesAcknowledged' && message.sequence === 1)).toBe(true);
        expect(viewer.durable().pendingEdits?.[0]?.conflicts ?? []).toEqual([]);
        expect(viewer.durable().pendingEdits?.[0]?.rowLayout).toBeUndefined();
        await viewer.dispose();
    });
});

describe('every exit before the write settles the intent', () => {
    it('clears it when the panel closes while the final stat fails', async () => {
        const drive = disk(BYTES);
        const state = store_with({ pendingEdits: slot(REMOVAL) });
        const viewer = await open_viewer({ state, disk: drive });
        drive.file.stat_calls = 0;
        vscode_mock.__setStatImplementation(async () => {
            drive.file.stat_calls += 1;
            if (drive.file.stat_calls === 3) {
                viewer.panel.dispose();
                throw new Error('EBUSY');
            }
            return { size: drive.file.bytes.length, mtime: drive.file.mtime };
        });
        void viewer.send_save(REMOVAL);
        await vi.waitFor(() => expect(drive.file.stat_calls).toBeGreaterThanOrEqual(3));
        await viewer.controller.drain();
        await vi.waitFor(() => expect(viewer.durable().structuralRekeyIntent).toBeUndefined());
        expect(drive.file.writes).toHaveLength(0);
        expect(viewer.durable().pendingEdits?.[0]).toMatchObject(REMOVAL);
    });
});
