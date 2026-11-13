// Host rules for Worksheet Layout state (row and column structure design,
// delivery step 3): peer compatibility rules 1-3, the admission ledger's
// origin rule, layout validation at publication, and the history replay
// commit carrying a stored layout (step 4).
import { createHash } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type * as vscode from 'vscode';
import { attach_viewer, csv_table_profile } from '../viewer-controller';
import { with_in_memory_authority_transactions } from '../state-authority';
import type { PerFileState, WorksheetPendingEdits } from '../types';
import type { StructuralBasis } from '../pending-changes';
import { versioned_state_store } from './helpers/versioned-state-store';
import * as vscode_mock from './mocks/vscode';
import { fake_viewer_host } from './mocks/host-ports';
import { history_value, value_only_overlay } from '../webview/history-cell-state-model';
import { wire_overlay_from_cell_overlay_state } from '../webview/history-replay-wire-model';

const enc = new TextEncoder();
// One header and three body rows: canonical source rows 0-2, one column.
const BYTES = enc.encode('h\na\nb\nc\n');
const FILE = '/tmp/structural-layout-host.csv';

const BASIS: StructuralBasis = {
    kind: 'delimited',
    byteLength: BYTES.length,
    // The real basis of BYTES: a recorded basis that no longer matched the
    // file would (correctly) record a structuralBasisChanged conflict on load.
    digest: createHash('sha256').update(BYTES).digest('hex'),
    sourceRowCount: 3,
    sourceColumnCount: 1,
};

const TEMPLATE = { id: 'plain', format: { kind: 'none' as const } };

const APPEND_BASIS = {
    sourceRowCount: 3,
    provisionalStartRow: 3,
    provisionalRowCount: 1,
    columnCount: 1,
    schemaFingerprint: `sha256:${createHash('sha256').update(JSON.stringify({
        columnCount: 1,
        columnNames: ['h'],
    })).digest('hex')}`,
};

/** Source row 1 removed. */
const REMOVAL_LAYOUT = {
    runs: [{ kind: 'source' as const, start: 0, count: 3 }],
    removedSourceRows: [{ start: 1, count: 1 }],
    discardedPendingRows: [],
};

/** Pending Inserted Row `ins` between source rows 0 and 1. */
const INSERT_LAYOUT = {
    runs: [
        { kind: 'source' as const, start: 0, count: 1 },
        { kind: 'pending' as const, ids: ['ins'] },
        { kind: 'source' as const, start: 1, count: 2 },
    ],
    removedSourceRows: [],
    discardedPendingRows: [],
};

const INSERTED_ROW = {
    id: 'ins',
    origin: 'insert' as const,
    cells: {},
    formatTemplateId: 'plain',
    createdOrder: 1,
};

function slot(fields: Partial<WorksheetPendingEdits>): PerFileState {
    return { pendingEdits: [{ sheetName: 'Sheet1', cells: {}, ...fields }] };
}

afterEach(() => {
    for (const panel of vscode_mock.__getPanels()) panel.dispose();
    vi.restoreAllMocks();
    vscode_mock.__reset();
});

type Message = { type?: string } & Record<string, unknown>;

async function open_viewer(options: {
    readonly initial?: PerFileState;
    readonly structuralEditingEnabled?: boolean;
    readonly declaresLayout?: boolean;
} = {}) {
    vscode_mock.__reset();
    vscode_mock.__setStatImplementation(async () => ({ size: BYTES.length, mtime: 1 }));
    vscode_mock.__setReadFileImplementation(async () => BYTES);
    const state = versioned_state_store(options.initial ?? {});
    const panel = vscode_mock.window.createWebviewPanel('tableViewer.editor', 'table');
    const controller = attach_viewer(
        panel as unknown as Parameters<typeof attach_viewer>[0],
        vscode_mock.Uri.file(FILE) as unknown as vscode.Uri,
        with_in_memory_authority_transactions(state.store),
        csv_table_profile(),
        fake_viewer_host,
        options.structuralEditingEnabled === undefined
            ? {}
            : { structuralEditingEnabled: options.structuralEditingEnabled },
    );
    panel.onDidDispose(() => controller.dispose());
    const warning = vi.spyOn(vscode_mock.window, 'showWarningMessage');
    warning.mockClear();
    await panel.__receive(options.declaresLayout === false
        ? { type: 'ready' }
        : { type: 'ready', structuralLayout: 1 });
    await panel.__receive({ type: 'requestEditSession', requestId: 'edit' });
    await controller.drain();
    const messages = () => panel.__messages as Message[];
    const session = [...messages()].reverse().find((message) =>
        message.type === 'editSessionResult') as {
        granted: boolean;
        editSessionId?: string;
        pendingChanges?: Record<string, unknown>;
    };
    const snapshot = messages().find((message) => message.type === 'workbookSnapshot') as {
        snapshot: { sourceGeneration: number };
    };
    let sequence = 0;
    const acknowledged = (type: string, at: number) => messages().some((message) =>
        message.type === type && message.sequence === at);
    return {
        panel,
        controller,
        state,
        session,
        warning,
        durable: () => state.get_state(FILE).pendingEdits?.[0],
        async publish(changes: Record<string, unknown>): Promise<boolean> {
            sequence += 1;
            await panel.__receive({
                type: 'pendingChangesChanged',
                editSessionId: session.editSessionId!,
                sequence,
                sourceGeneration: snapshot.snapshot.sourceGeneration,
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
            return acknowledged('pendingChangesAcknowledged', sequence);
        },
        async publish_legacy(edits: Record<string, unknown>): Promise<boolean> {
            sequence += 1;
            await panel.__receive({
                type: 'pendingEditsChanged',
                editSessionId: session.editSessionId!,
                sequence,
                sheetIndex: 0,
                sheetName: 'Sheet1',
                edits,
            });
            await controller.drain();
            return acknowledged('pendingEditsAcknowledged', sequence);
        },
        async append_row(): Promise<{ rowIds: string[]; formatTemplate: unknown; appendBasis: unknown }> {
            await panel.__receive({
                type: 'requestAppendRows',
                requestId: 'append',
                editSessionId: session.editSessionId!,
                worksheet: { sheetIndex: 0, sheetName: 'Sheet1' },
                sourceGeneration: snapshot.snapshot.sourceGeneration,
                count: 1,
            });
            const admission = [...messages()].reverse().find((message) =>
                message.type === 'appendRowsResult') as never;
            await panel.__receive({
                type: 'settleRowAdmission',
                requestId: 'append',
                editSessionId: session.editSessionId!,
                accepted: true,
            });
            await controller.drain();
            return admission;
        },
        async dispose() {
            panel.dispose();
            await controller.drain();
        },
    };
}

describe('peer compatibility rule 1: the ready declaration', () => {
    it('refuses editing version-2 durable state to a renderer that does not declare layouts', async () => {
        const viewer = await open_viewer({
            initial: slot({ rowLayout: REMOVAL_LAYOUT, structuralBasis: BASIS }),
            declaresLayout: false,
        });
        expect(viewer.session).toMatchObject({ granted: false });
        expect(viewer.warning).toHaveBeenCalledWith('Reload this window to keep editing this file.');
        await viewer.dispose();
    });

    it('grants it to a renderer that declares layouts, with the layout in the grant', async () => {
        const viewer = await open_viewer({
            initial: slot({ rowLayout: REMOVAL_LAYOUT, structuralBasis: BASIS }),
        });
        expect(viewer.session).toMatchObject({
            granted: true,
            pendingChanges: { rowLayout: REMOVAL_LAYOUT, structuralBasis: BASIS },
        });
        await viewer.dispose();
    });

    it('does not rehydrate a version-2 session for a renderer that does not declare layouts', async () => {
        const rehydrated = async (declaresLayout: boolean) => {
            const viewer = await open_viewer({
                initial: slot({
                    cells: { '0:0': { value: 'x', base: 'a' } },
                    rowLayout: REMOVAL_LAYOUT,
                    structuralBasis: BASIS,
                }),
                declaresLayout,
            });
            const snapshots = (viewer.panel.__messages as Message[]).filter((message) =>
                message.type === 'workbookSnapshot') as unknown as {
                snapshot: { capabilities: { csvEditSessionId?: string } };
            }[];
            const claimed = snapshots.some((message) =>
                message.snapshot.capabilities.csvEditSessionId !== undefined);
            const warned = viewer.warning.mock.calls.some(([message]) =>
                message === 'Reload this window to keep editing this file.');
            await viewer.dispose();
            return { claimed, warned };
        };
        expect(await rehydrated(false)).toEqual({ claimed: false, warned: true });
        expect(await rehydrated(true)).toEqual({ claimed: true, warned: false });
    });

    it('still grants version-1 durable state to an older renderer (upgrade path)', async () => {
        const viewer = await open_viewer({
            initial: slot({ cells: { '0:0': { value: 'x', base: 'a' } } }),
            declaresLayout: false,
        });
        expect(viewer.session).toMatchObject({ granted: true });
        await viewer.dispose();
    });
});

describe('peer compatibility rule 2: legacy-shaped publications', () => {
    it('keeps the stored layout fields and refuses a cell in a removed row', async () => {
        const viewer = await open_viewer({
            initial: slot({ rowLayout: REMOVAL_LAYOUT, structuralBasis: BASIS }),
        });
        expect(await viewer.publish_legacy({ '0:0': { value: 'typed', base: 'a' } })).toBe(true);
        expect(viewer.durable()).toMatchObject({
            cells: { '0:0': { value: 'typed', base: 'a' } },
            rowLayout: REMOVAL_LAYOUT,
            structuralBasis: BASIS,
        });

        expect(await viewer.publish_legacy({ '1:0': { value: 'lost', base: 'b' } })).toBe(false);
        expect(viewer.durable()?.cells).toEqual({ '0:0': { value: 'typed', base: 'a' } });
        await viewer.dispose();
    });
});

describe('peer compatibility rule 2: layout-free full snapshots', () => {
    it('keep the stored layout when the renderer never declared layouts', async () => {
        const viewer = await open_viewer({
            initial: slot({ cells: { '0:0': { value: 'x', base: 'a' } } }),
            declaresLayout: false,
        });
        expect(viewer.session).toMatchObject({ granted: true });
        // A layout stored while this older renderer still holds the session.
        const current = viewer.state.get_state(FILE);
        await viewer.state.store.compare_and_set(FILE, viewer.state.revision(FILE), {
            ...current,
            pendingEdits: [{ ...current.pendingEdits![0]!, rowLayout: REMOVAL_LAYOUT, structuralBasis: BASIS }],
        });

        expect(await viewer.publish({ cells: { '0:0': { value: 'typed', base: 'a' } } })).toBe(true);
        expect(viewer.durable()).toMatchObject({
            cells: { '0:0': { value: 'typed', base: 'a' } },
            rowLayout: REMOVAL_LAYOUT,
            structuralBasis: BASIS,
        });
        expect(await viewer.publish({ cells: { '1:0': { value: 'lost', base: 'b' } } })).toBe(false);
        expect(viewer.durable()?.cells).toEqual({ '0:0': { value: 'typed', base: 'a' } });
        await viewer.dispose();
    });

    it('mean the source layout from a renderer that declared layouts', async () => {
        const viewer = await open_viewer({
            initial: slot({ rowLayout: REMOVAL_LAYOUT, structuralBasis: BASIS }),
            structuralEditingEnabled: true,
        });
        expect(await viewer.publish({ cells: { '1:0': { value: 'v', base: 'b' } } })).toBe(true);
        expect(viewer.durable()).toEqual({
            sheetName: 'Sheet1',
            cells: { '1:0': { value: 'v', base: 'b' } },
            formatTemplates: [],
            appendedRows: [],
            tailRemovals: [],
            conflicts: [],
        });
        await viewer.dispose();
    });
});

describe('saves that would drop a stored layout', () => {
    it.each([
        ['with structural changes', { structuralChanges: { formatTemplates: [], appendedRows: [], tailRemovals: [], conflicts: [] } }],
        ['in the cell-only shape', {}],
    ])('are refused %s, without writing or replacing the slot', async (_label, structural) => {
        const viewer = await open_viewer({
            initial: slot({ cells: { '0:0': { value: 'x', base: 'a' } } }),
            declaresLayout: false,
        });
        expect(viewer.session).toMatchObject({ granted: true });
        const current = viewer.state.get_state(FILE);
        await viewer.state.store.compare_and_set(FILE, viewer.state.revision(FILE), {
            ...current,
            pendingEdits: [{ ...current.pendingEdits![0]!, rowLayout: REMOVAL_LAYOUT, structuralBasis: BASIS }],
        });
        const write = vi.spyOn(vscode_mock.workspace.fs, 'writeFile');
        await viewer.panel.__receive({
            type: 'saveCsv',
            operation: {
                editSessionId: viewer.session.editSessionId!,
                saveRequestId: 'save',
                worksheets: [{
                    sheetIndex: 0,
                    sheetName: 'Sheet1',
                    edits: { '0:0': 'x' },
                    dirtyEdits: { '0:0': { value: 'x', base: 'a' } },
                    ...structural,
                }],
            },
        });
        await viewer.controller.drain();
        expect((viewer.panel.__messages as Message[]).find((message) =>
            message.type === 'saveResult')).toMatchObject({ success: false });
        expect(write).not.toHaveBeenCalled();
        expect(viewer.durable()).toMatchObject({ rowLayout: REMOVAL_LAYOUT, structuralBasis: BASIS });
        await viewer.dispose();
    });
});

describe('peer compatibility rule 3: the release gate', () => {
    it('refuses a publication that carries layout fields while the flag is off', async () => {
        const viewer = await open_viewer();
        expect(await viewer.publish({ rowLayout: REMOVAL_LAYOUT, structuralBasis: BASIS })).toBe(false);
        expect(viewer.durable()).toBeUndefined();
        // Layout-free publications are unaffected.
        expect(await viewer.publish({ cells: { '0:0': { value: 'v', base: 'a' } } })).toBe(true);
        await viewer.dispose();
    });

    it('refuses a save that carries layout fields', async () => {
        const viewer = await open_viewer({
            initial: slot({ rowLayout: REMOVAL_LAYOUT, structuralBasis: BASIS }),
            structuralEditingEnabled: false,
        });
        const write = vi.spyOn(vscode_mock.workspace.fs, 'writeFile');
        await viewer.panel.__receive({
            type: 'saveCsv',
            operation: {
                editSessionId: viewer.session.editSessionId!,
                saveRequestId: 'save',
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
                        rowLayout: REMOVAL_LAYOUT,
                        structuralBasis: BASIS,
                    },
                }],
            },
        });
        await viewer.controller.drain();
        expect((viewer.panel.__messages as Message[]).find((message) =>
            message.type === 'saveResult')).toMatchObject({ success: false });
        expect(write).not.toHaveBeenCalled();
        expect(viewer.warning).toHaveBeenCalledWith(
            'Saving inserted, deleted, or moved rows and columns is not available in this version.',
        );
        expect(viewer.durable()).toMatchObject({ rowLayout: REMOVAL_LAYOUT });
        await viewer.dispose();
    });
});

describe('publication validation and the ledger origin rule', () => {
    it('accepts a valid layout against the recorded basis when the flag is on', async () => {
        const viewer = await open_viewer({
            initial: slot({ rowLayout: REMOVAL_LAYOUT, structuralBasis: BASIS }),
            structuralEditingEnabled: true,
        });
        const moved = {
            runs: [{ kind: 'source', start: 2, count: 1 }, { kind: 'source', start: 0, count: 2 }],
            removedSourceRows: [{ start: 1, count: 1 }],
            discardedPendingRows: [],
        };
        expect(await viewer.publish({
            cells: { '2:0': { value: 'v', base: 'c' } },
            rowLayout: moved,
            structuralBasis: BASIS,
        })).toBe(true);
        expect(viewer.durable()).toMatchObject({ rowLayout: moved, structuralBasis: BASIS });
        await viewer.dispose();
    });

    it.each<[string, Record<string, unknown>]>([
        ['a basis the session did not record', {
            rowLayout: REMOVAL_LAYOUT,
            structuralBasis: { ...BASIS, digest: 'sha256:other' },
        }],
        ['a live layout change without a basis', { rowLayout: REMOVAL_LAYOUT }],
        ['a layout that does not cover the file', {
            rowLayout: { ...REMOVAL_LAYOUT, runs: [{ kind: 'source', start: 0, count: 2 }] },
            structuralBasis: { ...BASIS, sourceRowCount: 2 },
        }],
        ['a cell edit in a removed row', {
            cells: { '1:0': { value: 'v', base: 'b' } },
            rowLayout: REMOVAL_LAYOUT,
            structuralBasis: BASIS,
        }],
        ['a Pending Column the host never issued', {
            columnLayout: {
                columns: [{ kind: 'source', sourceColumn: 0 }, { kind: 'pending', pendingColumnId: 'forged' }],
                removedSourceColumns: [],
                discardedPendingColumns: [],
            },
            pendingColumns: [{ id: 'forged', header: 'X', cells: {}, format: { kind: 'none' }, createdOrder: 9 }],
            structuralBasis: BASIS,
        }],
    ])('refuses %s', async (_label, changes) => {
        const viewer = await open_viewer({
            initial: slot({ rowLayout: REMOVAL_LAYOUT, structuralBasis: BASIS }),
            structuralEditingEnabled: true,
        });
        expect(await viewer.publish(changes)).toBe(false);
        expect(viewer.durable()).toMatchObject({ rowLayout: REMOVAL_LAYOUT, cells: {} });
        await viewer.dispose();
    });

    it('refuses origin insert for an id an append minted', async () => {
        const viewer = await open_viewer({ structuralEditingEnabled: true });
        const admission = await viewer.append_row();
        const row_id = admission.rowIds[0]!;
        expect(await viewer.publish({
            formatTemplates: [admission.formatTemplate],
            appendedRows: [{ id: row_id, origin: 'insert', cells: {}, formatTemplateId: (admission.formatTemplate as { id: string }).id, createdOrder: 1 }],
            appendBasis: admission.appendBasis,
            rowLayout: {
                runs: [{ kind: 'source', start: 0, count: 1 }, { kind: 'pending', ids: [row_id] }, { kind: 'source', start: 1, count: 2 }],
                removedSourceRows: [],
                discardedPendingRows: [],
            },
        })).toBe(false);
        // The same row published as an append is still accepted.
        expect(await viewer.publish({
            formatTemplates: [admission.formatTemplate],
            appendedRows: [{ id: row_id, cells: {}, formatTemplateId: (admission.formatTemplate as { id: string }).id, createdOrder: 1 }],
            appendBasis: admission.appendBasis,
        })).toBe(true);
        await viewer.dispose();
    });

    it('accepts origin insert for an id an insert minted, and origin append for it too', async () => {
        const viewer = await open_viewer({
            initial: slot({
                formatTemplates: [TEMPLATE],
                appendedRows: [INSERTED_ROW],
                appendBasis: APPEND_BASIS,
                rowLayout: INSERT_LAYOUT,
                structuralBasis: BASIS,
            }),
            structuralEditingEnabled: true,
        });
        expect(viewer.session).toMatchObject({ granted: true });
        expect(await viewer.publish({
            formatTemplates: [TEMPLATE],
            appendedRows: [{ ...INSERTED_ROW, cells: { 0: { value: 'typed' } } }],
            appendBasis: APPEND_BASIS,
            rowLayout: INSERT_LAYOUT,
            structuralBasis: BASIS,
        })).toBe(true);
        expect(viewer.durable()?.appendedRows?.[0]).toMatchObject({ origin: 'insert', cells: { 0: { value: 'typed' } } });

        // "Keep new rows at the end": the inserted row becomes an append and
        // leaves the layout.
        expect(await viewer.publish({
            formatTemplates: [TEMPLATE],
            appendedRows: [{ id: 'ins', cells: { 0: { value: 'typed' } }, formatTemplateId: 'plain', createdOrder: 2 }],
            appendBasis: APPEND_BASIS,
        })).toBe(true);
        expect(viewer.durable()?.appendedRows?.[0]?.origin).toBeUndefined();
        expect(viewer.durable()?.rowLayout).toBeUndefined();
        await viewer.dispose();
    });
});

describe('history replay commit', () => {
    const worksheet = { sheetIndex: 0, sheetName: 'Sheet1' };
    const EMPTY_STRUCTURE = { formatTemplates: [], appendedRows: [], tailRemovals: [], conflicts: [] };

    /** Prepare and commit one replay; whether the host committed it. */
    async function replay(
        viewer: Awaited<ReturnType<typeof open_viewer>>,
        id: string,
        request: {
            cells?: unknown[];
            structures?: { expected: unknown; desired: unknown }[];
        },
    ): Promise<boolean> {
        const messages = () => viewer.panel.__messages as Message[];
        const latest = [...messages()].reverse().find((message) =>
            message.type === 'workbookSnapshot') as unknown as { snapshot: { identity: unknown } };
        await viewer.panel.__receive({
            type: 'snapshotApplied',
            identity: latest.snapshot.identity,
            disposition: 'applied',
        });
        const cells = request.cells ?? [];
        const structures = request.structures ?? [];
        await viewer.panel.__receive({
            type: 'prepareHistoryReplay',
            request: {
                requestId: `${id}-prepare`,
                replayId: id,
                cells,
                highlights: [],
                structures: structures.map((structural, ordinal) => ({ ordinal, worksheet, ...structural })),
                focus: {
                    worksheet,
                    sourceRowStart: 0,
                    sourceRowEnd: 0,
                    sourceColumnStart: 0,
                    sourceColumnEnd: 0,
                },
            },
        });
        await viewer.controller.drain();
        const prepared = (messages().find((message) => message.type === 'historyReplayPrepared'
            && (message as { prepared?: { replayId?: string } }).prepared?.replayId === id) as {
            prepared?: { requestId: string; replayId: string; leaseId: string };
        } | undefined)?.prepared;
        if (prepared === undefined) return false;
        await viewer.panel.__receive({
            type: 'commitHistoryReplay',
            request: {
                requestId: prepared.requestId,
                replayId: prepared.replayId,
                leaseId: prepared.leaseId,
                mutationId: `${id}-mutation`,
                cells: cells.map((_cell, ordinal) => ({ ordinal, entry: null })),
                highlights: [],
                structures: structures.map((_structural, ordinal) => ({ ordinal })),
            },
        });
        await viewer.controller.drain();
        return messages().some((message) => message.type === 'historyReplayCommitted'
            && (message as { committed?: { replayId?: string } }).committed?.replayId === id);
    }

    const undo_cell = (sourceRow: number, value: string, base: string) => ({
        ordinal: 0,
        worksheet,
        sourceRow,
        sourceColumn: 0,
        overlay: wire_overlay_from_cell_overlay_state(value_only_overlay(
            history_value(value),
            history_value(base),
        )),
    });

    it('keeps the stored layout when it replays a cell edit on a worksheet with a layout', async () => {
        const viewer = await open_viewer({
            initial: slot({
                cells: { '0:0': { value: 'x', base: 'a' } },
                rowLayout: REMOVAL_LAYOUT,
                structuralBasis: BASIS,
            }),
            structuralEditingEnabled: true,
        });
        expect(viewer.session).toMatchObject({ granted: true });
        expect(await replay(viewer, 'cell', { cells: [undo_cell(0, 'x', 'a')] })).toBe(true);
        expect(viewer.durable()).toMatchObject({ rowLayout: REMOVAL_LAYOUT, structuralBasis: BASIS });
        expect(viewer.durable()?.cells ?? {}).toEqual({});
        await viewer.dispose();
    });

    it('refuses a replayed layout while structural editing is disabled', async () => {
        const viewer = await open_viewer({ initial: slot({ cells: { '0:0': { value: 'x', base: 'a' } } }) });
        expect(viewer.session).toMatchObject({ granted: true });
        expect(await replay(viewer, 'layout', {
            structures: [{
                expected: EMPTY_STRUCTURE,
                desired: { ...EMPTY_STRUCTURE, rowLayout: REMOVAL_LAYOUT, structuralBasis: BASIS },
            }],
        })).toBe(false);
        expect(viewer.durable()?.rowLayout).toBeUndefined();
        expect(viewer.durable()?.structuralBasis).toBeUndefined();
        await viewer.dispose();
    });

    it('refuses a replayed layout whose Structural Basis the session did not record', async () => {
        const viewer = await open_viewer({
            initial: slot({ rowLayout: REMOVAL_LAYOUT, structuralBasis: BASIS }),
            structuralEditingEnabled: true,
        });
        const current = { ...EMPTY_STRUCTURE, rowLayout: REMOVAL_LAYOUT, structuralBasis: BASIS };
        expect(await replay(viewer, 'basis', {
            structures: [{
                expected: current,
                desired: { ...current, structuralBasis: { ...BASIS, digest: 'sha256:forged' } },
            }],
        })).toBe(false);
        expect(viewer.durable()).toMatchObject({ structuralBasis: BASIS });
        await viewer.dispose();
    });
});

describe('the structural editing capability', () => {
    const current_basis: StructuralBasis = {
        kind: 'delimited',
        byteLength: BYTES.length,
        digest: createHash('sha256').update(BYTES).digest('hex'),
        sourceRowCount: 3,
        sourceColumnCount: 1,
    };
    const capabilities = (viewer: Awaited<ReturnType<typeof open_viewer>>) =>
        ([...(viewer.panel.__messages as Message[])].reverse().find((message) =>
            message.type === 'workbookSnapshot') as {
            snapshot: { capabilities: Record<string, unknown> };
        }).snapshot.capabilities;

    it('is absent while structural editing is off', async () => {
        const viewer = await open_viewer();
        expect(capabilities(viewer)).not.toHaveProperty('structuralEditing');
        await viewer.dispose();
    });

    it('reports CSV rows and columns supported, with the current file as the basis', async () => {
        const viewer = await open_viewer({ structuralEditingEnabled: true });
        expect(capabilities(viewer).structuralEditing).toEqual({
            sheets: [{
                rows: { supported: true },
                columns: { supported: true },
                basis: current_basis,
            }],
        });
        await viewer.dispose();
    });

    it('accepts a first delete authored against the current file, and no other basis', async () => {
        const viewer = await open_viewer({ structuralEditingEnabled: true });
        expect(await viewer.publish({
            rowLayout: REMOVAL_LAYOUT,
            structuralBasis: { ...current_basis, digest: 'sha256:other' },
        })).toBe(false);
        expect(await viewer.publish({
            rowLayout: REMOVAL_LAYOUT,
            structuralBasis: current_basis,
        })).toBe(true);
        expect(viewer.durable()).toMatchObject({
            rowLayout: REMOVAL_LAYOUT,
            structuralBasis: current_basis,
        });
        await viewer.dispose();
    });
});

describe('publishing a layout across an external change', () => {
    const basis_of = (bytes: Uint8Array, rows: number): StructuralBasis => ({
        kind: 'delimited',
        byteLength: bytes.length,
        digest: createHash('sha256').update(bytes).digest('hex'),
        sourceRowCount: rows,
        sourceColumnCount: 1,
    });

    it('keeps accepting the basis the first delete recorded after the file changes', async () => {
        const viewer = await open_viewer({ structuralEditingEnabled: true });
        const recorded = basis_of(BYTES, 3);
        expect(await viewer.publish({ rowLayout: REMOVAL_LAYOUT, structuralBasis: recorded })).toBe(true);

        // The file grows outside the session; the snapshot now reports its basis.
        const grown = enc.encode('h\na\nb\nc\nd\n');
        vscode_mock.__setStatImplementation(async () => ({ size: grown.length, mtime: 2 }));
        vscode_mock.__setReadFileImplementation(async () => grown);
        await vscode_mock.__getActiveWatchers()[0].__fireChange();
        await viewer.controller.drain();
        const latest = [...(viewer.panel.__messages as Message[])].reverse().find((message) =>
            message.type === 'workbookSnapshot') as {
            snapshot: { sourceGeneration: number; capabilities: Record<string, unknown> };
        };
        expect(latest.snapshot.capabilities.structuralEditing).toMatchObject({
            sheets: [{ basis: basis_of(grown, 4) }],
        });

        // The webview keeps publishing the layout it authored, with its basis.
        await viewer.panel.__receive({
            type: 'pendingChangesChanged',
            editSessionId: viewer.session.editSessionId!,
            sequence: 2,
            sourceGeneration: latest.snapshot.sourceGeneration,
            changes: {
                sheetIndex: 0,
                sheetName: 'Sheet1',
                cells: { '0:0': { value: 'v', base: 'a' } },
                formatTemplates: [],
                appendedRows: [],
                tailRemovals: [],
                conflicts: [],
                rowLayout: REMOVAL_LAYOUT,
                structuralBasis: recorded,
            },
        });
        await viewer.controller.drain();
        expect((viewer.panel.__messages as Message[]).some((message) =>
            message.type === 'pendingChangesAcknowledged' && message.sequence === 2)).toBe(true);
        await viewer.dispose();
    });

    it('fails a pending-edit flush at once when the host refused the publication it waits on', async () => {
        const viewer = await open_viewer({ structuralEditingEnabled: true });
        expect(await viewer.publish({
            rowLayout: REMOVAL_LAYOUT,
            structuralBasis: { ...basis_of(BYTES, 3), digest: 'sha256:never' },
        })).toBe(false);
        const flushed = viewer.controller.flush_pending_edits();
        const request = [...(viewer.panel.__messages as Message[])].reverse().find((message) =>
            message.type === 'requestPendingEditsFlush') as { requestId: string };
        await viewer.panel.__receive({
            type: 'pendingEditsFlush',
            requestId: request.requestId,
            editSessionId: viewer.session.editSessionId!,
            highestProducedSequence: 1,
        });
        await expect(flushed).rejects.toThrow('refused the pending changes');
        await viewer.dispose();
    });
});
