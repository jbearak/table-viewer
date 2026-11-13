// Columns through the controller (row and column structure design, delivery
// step 8): column insert admission and its refusals, the one reservation slot
// a worksheet's row and column admissions share, settling and publication of
// minted Pending Column IDs, the save ordering rule, and a CSV save that
// writes column changes, rekeys column-keyed view state, and recovers after a
// stop between the write and the post-write transition.
import { createHash } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type * as vscode from 'vscode';
import {
    attach_viewer,
    csv_table_profile,
    simulate_process_restart_for_tests,
    UNSETTLED_ADMISSION_SAVE_MESSAGE,
} from '../viewer-controller';
import { with_in_memory_authority_transactions } from '../state-authority';
import {
    transform_schema_for_sheet,
    type PerFileState,
    type WorksheetPendingEdits,
} from '../types';
import { MAX_PENDING_COLUMNS, type PendingColumn, type StructuralBasis } from '../pending-changes';
import type { ColumnLayout } from '../worksheet-layout';
import { versioned_state_store } from './helpers/versioned-state-store';
import * as vscode_mock from './mocks/vscode';
import { fake_viewer_host } from './mocks/host-ports';

const enc = new TextEncoder();
const dec = new TextDecoder();
// Two body rows, three columns; the header's middle field is quoted.
const TEXT = 'name,"unit, price",qty\na,1,2\nb,3,4\n';
const BYTES = enc.encode(TEXT);
const FILE = '/tmp/column-structure-host.csv';
const NAMES = ['name', 'unit, price', 'qty'];
const SCHEMA = transform_schema_for_sheet({ name: 'Sheet1', columnCount: 3, columnNames: NAMES } as never);
const hex = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const BASIS: StructuralBasis = {
    kind: 'delimited',
    byteLength: BYTES.byteLength,
    digest: hex(BYTES),
    sourceRowCount: 2,
    sourceColumnCount: 3,
};

afterEach(() => {
    for (const panel of vscode_mock.__getPanels()) panel.dispose();
    vi.restoreAllMocks();
    vscode_mock.__reset();
    simulate_process_restart_for_tests();
});

type Message = { type?: string } & Record<string, unknown>;

interface Reply {
    readonly granted: boolean;
    readonly columnIds?: readonly string[];
    readonly rowIds?: readonly string[];
    readonly structuralBasis?: StructuralBasis;
    readonly reason?: string;
}

function disk(initial: Uint8Array) {
    const file = {
        bytes: initial,
        mtime: 1,
        write: undefined as ((content: Uint8Array) => Promise<void>) | undefined,
        writes: [] as Uint8Array[],
    };
    const install = () => {
        vscode_mock.__setStatImplementation(async () => ({ size: file.bytes.length, mtime: file.mtime }));
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
    readonly state?: ReturnType<typeof versioned_state_store>;
    readonly drive?: ReturnType<typeof disk>;
} = {}) {
    const drive = options.drive ?? disk(BYTES);
    drive.install();
    const state = options.state ?? versioned_state_store({});
    const panel = vscode_mock.window.createWebviewPanel('tableViewer.editor', 'table');
    const controller = attach_viewer(
        panel as unknown as Parameters<typeof attach_viewer>[0],
        vscode_mock.Uri.file(FILE) as unknown as vscode.Uri,
        with_in_memory_authority_transactions(state.store),
        csv_table_profile(),
        fake_viewer_host,
        { structuralEditingEnabled: true },
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
        drive,
        warning,
        messages,
        last,
        durable: () => state.get_state(FILE) as PerFileState,
        async insert(request: {
            readonly requestId: string;
            readonly axis?: 'rows' | 'columns';
            readonly anchor?: unknown;
            readonly side?: 'before' | 'after';
            readonly count?: number;
        }): Promise<Reply> {
            await panel.__receive({
                type: 'requestStructuralInsert',
                requestId: request.requestId,
                editSessionId: session_id()!,
                worksheet: { sheetIndex: 0, sheetName: 'Sheet1' },
                sourceGeneration: generation(),
                axis: request.axis ?? 'columns',
                anchor: request.anchor ?? { column: { kind: 'source', sourceColumn: 0 } },
                side: request.side ?? 'after',
                count: request.count ?? 1,
            });
            await controller.drain();
            return [...messages()].reverse().find((message) =>
                message.type === 'structuralInsertResult' && message.requestId === request.requestId) as never;
        },
        async settle(request_id: string, accepted: boolean): Promise<void> {
            await panel.__receive({ type: 'settleRowAdmission', requestId: request_id, editSessionId: session_id()!, accepted });
            await controller.drain();
        },
        async append(request_id: string): Promise<{ granted: boolean; reason?: string }> {
            await panel.__receive({
                type: 'requestAppendRows',
                requestId: request_id,
                editSessionId: session_id()!,
                worksheet: { sheetIndex: 0, sheetName: 'Sheet1' },
                sourceGeneration: generation(),
                count: 1,
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
        send_save(structural: Partial<WorksheetPendingEdits>): Promise<void> {
            return panel.__receive({
                type: 'saveCsv',
                operation: {
                    editSessionId: session_id()!,
                    saveRequestId: `save-${Math.random()}`,
                    worksheets: [{
                        sheetIndex: 0,
                        sheetName: 'Sheet1',
                        edits: {},
                        dirtyEdits: {},
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
            return last<{ success: boolean; receipt?: unknown }>('saveResult');
        },
        async dispose() {
            panel.dispose();
            await controller.drain();
        },
    };
    return viewer;
}

function new_column(id: string, extra: Partial<PendingColumn> = {}): PendingColumn {
    return { id, header: 'New column', cells: {}, format: { kind: 'none' }, createdOrder: 1, ...extra };
}

/** The changes a granted insert of `ids` after column 0 makes. */
function inserted_changes(ids: readonly string[], basis = BASIS): Partial<WorksheetPendingEdits> {
    return {
        columnLayout: {
            columns: [
                { kind: 'source', sourceColumn: 0 },
                ...ids.map((pendingColumnId) => ({ kind: 'pending' as const, pendingColumnId })),
                { kind: 'source', sourceColumn: 1 },
                { kind: 'source', sourceColumn: 2 },
            ],
            removedSourceColumns: [],
            discardedPendingColumns: [],
        },
        pendingColumns: ids.map((id, index) => new_column(id, { createdOrder: index + 1 })),
        structuralBasis: basis,
    };
}

describe('column insert admission', () => {
    it('mints Pending Column IDs with the Structural Basis, and publication accepts them once installed', async () => {
        const viewer = await open_viewer();
        const reply = await viewer.insert({ requestId: 'cols', count: 2 });
        expect(reply).toMatchObject({
            granted: true,
            columnIds: [expect.stringMatching(/^insert-column:/), expect.stringMatching(/^insert-column:/)],
            structuralBasis: BASIS,
        });
        expect(reply.rowIds).toBeUndefined();
        await viewer.settle('cols', true);
        expect(await viewer.publish(inserted_changes(reply.columnIds!))).toBe(true);
        expect(viewer.durable().pendingEdits?.[0]?.pendingColumns?.map((column) => column.id)).toEqual(reply.columnIds);
        await viewer.dispose();
    });

    it('forgets released IDs, so publishing one is refused', async () => {
        const viewer = await open_viewer();
        const reply = await viewer.insert({ requestId: 'cols' });
        await viewer.settle('cols', false);
        expect(await viewer.publish(inserted_changes(reply.columnIds!))).toBe(false);
        expect(await viewer.publish(inserted_changes(['never-minted']))).toBe(false);
        await viewer.dispose();
    });

    it('shares the worksheet\'s one reservation slot with row admissions, both ways', async () => {
        const viewer = await open_viewer();
        const columns = await viewer.insert({ requestId: 'cols' });
        expect(columns.granted).toBe(true);
        expect(await viewer.insert({ requestId: 'rows', axis: 'rows', anchor: { row: { kind: 'source', sourceRow: 0 } } }))
            .toMatchObject({ granted: false, reason: 'Another row append is still being installed. Try again.' });
        expect(await viewer.append('app')).toMatchObject({ granted: false });
        expect(await viewer.insert({ requestId: 'cols-2' }))
            .toMatchObject({ granted: false, reason: 'Another row append is still being installed. Try again.' });
        await viewer.settle('cols', true);
        const rows = await viewer.insert({ requestId: 'rows-2', axis: 'rows', anchor: { row: { kind: 'source', sourceRow: 0 } } });
        expect(rows.granted).toBe(true);
        expect(await viewer.insert({ requestId: 'cols-3' }))
            .toMatchObject({ granted: false, reason: 'Another row append is still being installed. Try again.' });
        await viewer.dispose();
    });

    it('releases an unsettled column reservation when the renderer reloads, so the slot and Save are free', async () => {
        const viewer = await open_viewer();
        const reply = await viewer.insert({ requestId: 'cols' });
        expect(reply.granted).toBe(true);
        // The renderer reloads before it settles the grant.
        await viewer.panel.__receive({ type: 'ready', structuralLayout: 1 });
        await viewer.panel.__receive({ type: 'requestEditSession', requestId: 'edit-2' });
        await viewer.controller.drain();
        const rows = await viewer.insert({ requestId: 'rows', axis: 'rows', anchor: { row: { kind: 'source', sourceRow: 0 } } });
        expect(rows.reason).toBeUndefined();
        expect(rows.granted).toBe(true);
        await viewer.settle('rows', false);
        expect(await viewer.insert({ requestId: 'cols-2' })).toMatchObject({ granted: true });
        await viewer.settle('cols-2', false);
        // The released IDs were never installed, so they stay unpublishable.
        expect(await viewer.publish(inserted_changes(reply.columnIds!))).toBe(false);
        expect(await viewer.save({})).toMatchObject({ success: true });
        expect(viewer.warning).not.toHaveBeenCalledWith(UNSETTLED_ADMISSION_SAVE_MESSAGE);
        await viewer.dispose();
    });

    it('refuses a save while a column admission is unsettled', async () => {
        const viewer = await open_viewer();
        const reply = await viewer.insert({ requestId: 'cols' });
        const result = await viewer.save(inserted_changes(reply.columnIds!));
        expect(result).toMatchObject({ success: false });
        expect(viewer.warning).toHaveBeenCalledWith(UNSETTLED_ADMISSION_SAVE_MESSAGE);
        expect(dec.decode(viewer.drive.file.bytes)).toBe(TEXT);
        await viewer.settle('cols', true);
        expect(await viewer.save(inserted_changes(reply.columnIds!))).toMatchObject({ success: true });
        expect(dec.decode(viewer.drive.file.bytes))
            .toBe('name,New column,"unit, price",qty\na,,1,2\nb,,3,4\n');
        await viewer.dispose();
    });

    it('refuses too many columns, an anchor outside the sheet or removed, and a stale basis', async () => {
        const viewer = await open_viewer();
        expect(await viewer.insert({ requestId: 'many', count: MAX_PENDING_COLUMNS + 1 }))
            .toMatchObject({ granted: false, reason: `Insert at most ${MAX_PENDING_COLUMNS} columns at once.` });
        expect(await viewer.insert({ requestId: 'wide', count: MAX_PENDING_COLUMNS }))
            .toMatchObject({ granted: false, reason: "Can't add columns here: a sheet can have at most 256 columns." });
        expect(await viewer.insert({ requestId: 'out', anchor: { column: { kind: 'source', sourceColumn: 3 } } }))
            .toMatchObject({ granted: false, reason: 'The insert names no column of this worksheet.' });
        expect(await viewer.insert({ requestId: 'shape', anchor: { column: { kind: 'other' } } }))
            .toMatchObject({ granted: false });
        await viewer.dispose();

        const removed_layout: ColumnLayout = {
            columns: [0, 1, 2].map((sourceColumn) => ({ kind: 'source', sourceColumn })),
            removedSourceColumns: [1],
            discardedPendingColumns: [],
        };
        const with_removal = await open_viewer({
            state: versioned_state_store({ pendingEdits: [{ sheetName: 'Sheet1', cells: {}, columnLayout: removed_layout, structuralBasis: BASIS }] }),
        });
        expect(await with_removal.insert({ requestId: 'gone', anchor: { column: { kind: 'source', sourceColumn: 1 } } }))
            .toMatchObject({ granted: false, reason: 'Insert canceled because its column was removed.' });
        await with_removal.dispose();

        const stale = await open_viewer({
            state: versioned_state_store({ pendingEdits: [{
                sheetName: 'Sheet1',
                cells: {},
                columnLayout: removed_layout,
                structuralBasis: { ...BASIS, digest: 'other' },
            }] }),
        });
        expect((await stale.insert({ requestId: 'stale' })).reason)
            .toMatch(/changed on disk after you inserted, deleted, or moved rows or columns/);
        await stale.dispose();
    });
});

describe('Pending Columns reachable only from history', () => {
    const retain = (viewer: Awaited<ReturnType<typeof open_viewer>>, pendingColumnIds: readonly string[]) =>
        viewer.panel.__receive({
            type: 'retainedSavedAppendAuthoritiesChanged',
            authorities: [{ sheetIndex: 0, sheetName: 'Sheet1', appendHistoryIds: [], pendingRowIds: [], pendingColumnIds }],
        });

    async function prepare_replay(viewer: Awaited<ReturnType<typeof open_viewer>>, id: string, desired: Partial<WorksheetPendingEdits>) {
        const empty = { formatTemplates: [], appendedRows: [], tailRemovals: [], conflicts: [] };
        await viewer.panel.__receive({
            type: 'prepareHistoryReplay',
            request: {
                requestId: `${id}-prepare`,
                replayId: id,
                cells: [],
                highlights: [],
                structures: [{
                    ordinal: 0,
                    worksheet: { sheetIndex: 0, sheetName: 'Sheet1' },
                    expected: empty,
                    desired: { ...empty, ...desired },
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
            (message.type === 'historyReplayPrepared' || message.type === 'historyReplayPrepareRefused')
            && JSON.stringify(message).includes(id))).toBe(true));
        return viewer.messages().some((message) =>
            message.type === 'historyReplayPrepared' && JSON.stringify(message).includes(id));
    }

    async function new_session(viewer: Awaited<ReturnType<typeof open_viewer>>, request_id: string) {
        await viewer.panel.__receive({ type: 'releaseEditSession', editSessionId: viewer.last<{ editSessionId: string }>('editSessionResult').editSessionId });
        await viewer.controller.drain();
        await viewer.panel.__receive({ type: 'requestEditSession', requestId: request_id });
        await viewer.controller.drain();
        expect(viewer.last<{ granted: boolean }>('editSessionResult').granted).toBe(true);
    }

    it('replays a discarded Pending Column into a new session while history retains it', async () => {
        const viewer = await open_viewer();
        const reply = await viewer.insert({ requestId: 'cols' });
        await viewer.settle('cols', true);
        const changes = inserted_changes(reply.columnIds!);
        expect(await viewer.publish(changes)).toBe(true);
        await retain(viewer, reply.columnIds!);
        // Discard: the durable changes go, and the session ends.
        expect(await viewer.publish({})).toBe(true);
        await new_session(viewer, 'again');
        // Undo brings the column back against the new session's ledger.
        expect(await prepare_replay(viewer, 'undo-discard', changes)).toBe(true);
        expect(await viewer.publish(changes)).toBe(true);
        expect(viewer.durable().pendingEdits?.[0]?.pendingColumns?.map((column) => column.id)).toEqual(reply.columnIds);
        await viewer.dispose();
    });

    it('counts a retained column against the new session\'s 256 column admissions', async () => {
        const viewer = await open_viewer();
        const reply = await viewer.insert({ requestId: 'cols' });
        await viewer.settle('cols', true);
        const changes = inserted_changes(reply.columnIds!);
        expect(await viewer.publish(changes)).toBe(true);
        await retain(viewer, reply.columnIds!);
        expect(await viewer.publish({})).toBe(true);
        await new_session(viewer, 'again');
        // The new session owns 256 column admissions: 253 inserted and
        // undone, then 3 more.
        const many = await viewer.insert({ requestId: 'many', count: 253 });
        await viewer.settle('many', true);
        expect(await viewer.publish(inserted_changes(many.columnIds!))).toBe(true);
        expect(await viewer.publish({})).toBe(true);
        const more = await viewer.insert({ requestId: 'more', count: 3 });
        expect(more.granted).toBe(true);
        await viewer.settle('more', true);
        // Undo the Discard: one more owned ID would be the 257th.
        expect(await prepare_replay(viewer, 'undo-discard', changes)).toBe(false);
        expect(await viewer.publish(changes)).toBe(false);
        await viewer.dispose();
    });

    it('does not widen ownership: an ID history names but no session owned, or one history let go, stays refused', async () => {
        const viewer = await open_viewer();
        const reply = await viewer.insert({ requestId: 'cols' });
        await viewer.settle('cols', true);
        const changes = inserted_changes(reply.columnIds!);
        expect(await viewer.publish(changes)).toBe(true);
        // History names a foreign ID alongside the real one.
        await retain(viewer, [...reply.columnIds!, 'insert-column:forged']);
        expect(await viewer.publish({})).toBe(true);
        await new_session(viewer, 'again');
        const forged = inserted_changes(['insert-column:forged']);
        expect(await prepare_replay(viewer, 'forged', forged)).toBe(false);
        expect(await viewer.publish(forged)).toBe(false);
        // History drops the column (its actions fell off the stack): the
        // retained authority goes with it.
        await retain(viewer, []);
        expect(await prepare_replay(viewer, 'dropped', changes)).toBe(false);
        expect(await viewer.publish(changes)).toBe(false);
        await viewer.dispose();
    });
});

describe('saving column changes', () => {
    // Column 1 ("unit, price") deleted, qty moved to the front, a Pending
    // Column "note" at the end.
    const LAYOUT: ColumnLayout = {
        columns: [
            { kind: 'source', sourceColumn: 2 },
            { kind: 'source', sourceColumn: 0 },
            { kind: 'source', sourceColumn: 1 },
            { kind: 'pending', pendingColumnId: 'note' },
        ],
        removedSourceColumns: [1],
        discardedPendingColumns: [],
    };
    const NOTE = new_column('note', {
        header: 'a, note',
        cells: { 's:0': { value: 'x' } },
        viewerWidth: 77,
        highlights: { 's:1': 'yellow' },
    });
    const CHANGES: Partial<WorksheetPendingEdits> = {
        columnLayout: LAYOUT,
        pendingColumns: [NOTE],
        structuralBasis: BASIS,
    };
    const SAVED = 'qty,name,"a, note"\n2,a,x\n4,b,\n';
    const VIEW: PerFileState = {
        cellHighlights: {
            sourceDigest: hex(BYTES),
            sheets: [{ schema: SCHEMA, cells: { '0:1': 'green', '1:2': 'blue', '0:0': 'pink' } }],
        },
        columnWidths: [{ 0: 100, 1: 110, 2: 130 }],
        columnVisibility: [{ hiddenColumns: [0], schema: SCHEMA }],
        transforms: [{
            sort: [{ colIndex: 1, direction: 'asc' }],
            filters: [{ id: 'f1', colIndex: 2, operator: 'equals', value: '2', caseSensitive: false, enabled: false }],
            schema: SCHEMA,
        }],
        pendingEdits: [{ sheetName: 'Sheet1', cells: {}, ...CHANGES }],
    };

    function check_rekeyed(durable: PerFileState): void {
        expect(durable.structuralRekeyIntent).toBeUndefined();
        expect(durable.pendingEdits).toBeUndefined();
        expect(durable.cellHighlights?.sheets[0]?.cells).toEqual({ '1:0': 'blue', '0:1': 'pink', '1:2': 'yellow' });
        expect(durable.cellHighlights?.sourceDigest).toBe(hex(enc.encode(SAVED)));
        expect(durable.columnWidths?.[0]).toEqual({ 0: 130, 1: 100, 2: 77 });
        expect(durable.columnVisibility?.[0]?.hiddenColumns).toEqual([1]);
        expect(durable.transforms?.[0]?.sort).toEqual([]);
        expect(durable.transforms?.[0]?.filters).toMatchObject([{ colIndex: 0 }]);
        const schema = transform_schema_for_sheet({
            name: 'Sheet1', columnCount: 3, columnNames: ['qty', 'name', 'a, note'],
        } as never);
        expect(durable.transforms?.[0]?.schema).toBe(schema);
        expect(durable.columnVisibility?.[0]?.schema).toBe(schema);
    }

    it('writes the columns, reports the column map, and rekeys column-keyed view state', async () => {
        const viewer = await open_viewer({ state: versioned_state_store(VIEW) });
        const result = await viewer.save(CHANGES);
        expect(result).toMatchObject({
            success: true,
            receipt: { structure: [{ columnMap: [1, null, 0], insertedColumns: [{ pendingColumnId: 'note', column: 2 }] }] },
        });
        expect(dec.decode(viewer.drive.file.bytes)).toBe(SAVED);
        await vi.waitFor(() => expect(viewer.durable().pendingEdits).toBeUndefined());
        check_rekeyed(viewer.durable());
        // The toolbar's live region, not a warning, names the dropped sort.
        await vi.waitFor(() => expect(viewer.messages()).toContainEqual({
            type: 'toolbarAnnouncement',
            message: 'Removed the sort on unit, price because the column was deleted.',
        }));
        expect(viewer.warning).not.toHaveBeenCalled();
        await viewer.dispose();
    });

    it('applies the intent on reload after a stop between the write and the post-write transition', async () => {
        const drive = disk(BYTES);
        const state = versioned_state_store(VIEW);
        const first = await open_viewer({ state, drive });
        drive.file.write = (content) => {
            drive.file.bytes = content;
            drive.file.mtime += 1;
            return new Promise<never>(() => {});
        };
        void first.send_save(CHANGES);
        await vi.waitFor(() => expect(drive.file.writes).toHaveLength(1));
        expect(state.get_state(FILE).structuralRekeyIntent).toMatchObject({
            receipt: { structure: [{ columnMap: [1, null, 0] }] },
        });
        // The write never settles: close the panel without draining it.
        first.panel.dispose();
        simulate_process_restart_for_tests();
        drive.file.write = undefined;
        const second = await open_viewer({ state, drive });
        check_rekeyed(second.durable());
        expect(dec.decode(drive.file.bytes)).toBe(SAVED);
        await second.dispose();
    });

    it('refuses a save whose basis no longer describes the file', async () => {
        const viewer = await open_viewer({ state: versioned_state_store(VIEW) });
        const result = await viewer.save({ ...CHANGES, structuralBasis: { ...BASIS, sourceColumnCount: 4 } });
        expect(result).toMatchObject({ success: false });
        expect(dec.decode(viewer.drive.file.bytes)).toBe(TEXT);
        await viewer.dispose();
    });
});
