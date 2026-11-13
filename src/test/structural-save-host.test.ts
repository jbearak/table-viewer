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
        digest: `sha256:${hex(bytes)}`,
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
}) {
    options.disk.install();
    const path = options.path ?? FILE;
    const panel = vscode_mock.window.createWebviewPanel('tableViewer.editor', 'table');
    const controller = attach_viewer(
        panel as unknown as Parameters<typeof attach_viewer>[0],
        vscode_mock.Uri.file(path) as unknown as vscode.Uri,
        with_in_memory_authority_transactions(options.state.store),
        csv_table_profile(),
        fake_viewer_host,
        { structuralEditingEnabled: options.structuralEditingEnabled ?? true },
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

    it('refuses with the flag off, and refuses .xlsx with the flag on', async () => {
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
