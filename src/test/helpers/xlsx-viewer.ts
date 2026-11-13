// A `.xlsx` file opened through the controller with structural editing on,
// for the structural save tests: admission, publication, save, and refresh
// messages, and the file on disk.
import { vi } from 'vitest';
import type * as vscode from 'vscode';
import { attach_viewer, profile_for } from '../../viewer-controller';
import { with_in_memory_authority_transactions } from '../../state-authority';
import type { PerFileState, WorksheetPendingEdits } from '../../types';
import type { PendingRowFormatTemplate, StructuralBasis } from '../../pending-changes';
import type { StructuralEditingCapability } from '../../viewer-snapshot';
import { ZipPackage } from '../../zip-package';
import { versioned_state_store } from './versioned-state-store';
import * as vscode_mock from '../mocks/vscode';
import { fake_viewer_host } from '../mocks/host-ports';

export const FILE = '/tmp/xlsx-structural-save-host.xlsx';

type Message = { type?: string } & Record<string, unknown>;

export function disk(initial: Uint8Array) {
    const file = {
        bytes: initial,
        mtime: 1,
        writes: [] as Uint8Array[],
        /** Replace the default write, to stop a save after its bytes land. */
        write: undefined as ((content: Uint8Array) => Promise<void>) | undefined,
    };
    vscode_mock.__setStatImplementation(async () => ({ size: file.bytes.length, mtime: file.mtime }));
    vscode_mock.__setReadFileImplementation(async () => file.bytes);
    vscode_mock.__setWriteFileImplementation(async (_uri, content) => {
        file.writes.push(content);
        if (file.write) return file.write(content);
        file.bytes = content;
        file.mtime += 1;
    });
    return file;
}

/** The package with each listed part replaced (or added). */
export function with_parts(raw: Uint8Array, parts: Readonly<Record<string, string>>): Uint8Array {
    const zip = ZipPackage.open(raw);
    for (const [path, text] of Object.entries(parts)) {
        const bytes = Buffer.from(text, 'utf8');
        if (!zip.replace(`/${path}`, bytes)) zip.add(`/${path}`, bytes);
    }
    return zip.write();
}

export interface OpenXlsx {
    readonly file: ReturnType<typeof disk>;
    /** Change the file on disk and let the watcher refresh the source. */
    change(bytes: Uint8Array): Promise<void>;
    dispose(): void;
    readonly messages: () => Message[];
    readonly warning: ReturnType<typeof vi.spyOn>;
    readonly store?: unknown;
    durable(): PerFileState;
    capability(): StructuralEditingCapability;
    basis(sheet_index: number): StructuralBasis;
    insert(request: { anchor: number; side: 'before' | 'after'; count?: number; requestId: string; sheet?: number }): Promise<{
        granted: boolean;
        reason?: string;
        rowIds?: string[];
        formatTemplate?: PendingRowFormatTemplate;
        structuralBasis?: StructuralBasis;
        appendBasis?: WorksheetPendingEdits['appendBasis'];
    }>;
    /** Request a column insert beside a source column of sheet 0. */
    insertColumns(request: { anchor: number; side: 'before' | 'after'; count?: number; requestId: string }): Promise<{
        granted: boolean;
        reason?: string;
        columnIds?: string[];
        structuralBasis?: StructuralBasis;
    }>;
    append(request_id: string, count: number): Promise<{
        granted: boolean;
        rowIds?: string[];
        formatTemplate?: PendingRowFormatTemplate;
        appendBasis?: WorksheetPendingEdits['appendBasis'];
    }>;
    settle(request_id: string, accepted: boolean): Promise<void>;
    publish(sheet_index: number, changes: Partial<WorksheetPendingEdits>): Promise<boolean>;
    save(worksheets: readonly {
        sheetIndex: number;
        structural?: Partial<WorksheetPendingEdits>;
        cells?: Record<string, { value: string; base: string }>;
    }[]): Promise<{ success: boolean; receipt?: Record<string, unknown>; rejection?: Record<string, unknown> }>;
    /**
     * Prepare and commit one history replay of cell overlays on sheet 0; the
     * committed message, or undefined when the host refused it.
     */
    replay(id: string, cells: readonly unknown[]): Promise<Record<string, unknown> | undefined>;
}

export async function open_xlsx(
    bytes: Uint8Array,
    options: {
        readonly state?: PerFileState;
        readonly store?: ReturnType<typeof versioned_state_store>;
        readonly disk?: ReturnType<typeof disk>;
        /** Defaults to on. */
        readonly structuralEditingEnabled?: boolean;
        /** Defaults to the `.xlsx` profile. */
        readonly profile?: ReturnType<typeof profile_for>;
    } = {},
): Promise<OpenXlsx & { readonly store: ReturnType<typeof versioned_state_store> }> {
    const file = options.disk ?? disk(bytes);
    const state = options.store ?? versioned_state_store(options.state ?? {});
    const panel = vscode_mock.window.createWebviewPanel('tableViewer.editor', 'table');
    const controller = attach_viewer(
        panel as unknown as Parameters<typeof attach_viewer>[0],
        vscode_mock.Uri.file(FILE) as unknown as vscode.Uri,
        with_in_memory_authority_transactions(state.store),
        options.profile ?? profile_for(FILE),
        fake_viewer_host,
        { structuralEditingEnabled: options.structuralEditingEnabled ?? true },
    );
    panel.onDidDispose(() => controller.dispose());
    const warning = vi.spyOn(vscode_mock.window, 'showWarningMessage');
    await panel.__receive({ type: 'ready', structuralLayout: 1 });
    await panel.__receive({ type: 'requestEditSession', requestId: 'edit' });
    await controller.drain();
    const messages = () => panel.__messages as Message[];
    const last = <T,>(type: string) => [...messages()].reverse().find((message) => message.type === type) as T;
    const session_id = () => last<{ editSessionId?: string }>('editSessionResult')?.editSessionId;
    const snapshot = () => last<{ snapshot: {
        sourceGeneration: number;
        meta: { sheets: { name: string }[] };
        capabilities: { structuralEditing?: StructuralEditingCapability };
    } }>('workbookSnapshot').snapshot;
    const sheet_name = (index: number) => snapshot().meta.sheets[index]!.name;
    let sequence = 0;
    let save_sequence = 0;
    return {
        file,
        store: state,
        async change(next) {
            file.bytes = next;
            file.mtime += 1;
            await vscode_mock.__getWatchers()[0]!.__fireChange();
            await controller.drain();
        },
        dispose: () => panel.dispose(),
        messages,
        warning,
        durable: () => state.get_state(FILE) as PerFileState,
        capability: () => snapshot().capabilities.structuralEditing!,
        basis: (index) => snapshot().capabilities.structuralEditing!.sheets[index]!.basis!,
        async insert(request) {
            await panel.__receive({
                type: 'requestStructuralInsert',
                requestId: request.requestId,
                editSessionId: session_id()!,
                worksheet: { sheetIndex: request.sheet ?? 0, sheetName: sheet_name(request.sheet ?? 0) },
                sourceGeneration: snapshot().sourceGeneration,
                axis: 'rows',
                anchor: { row: { kind: 'source', sourceRow: request.anchor } },
                side: request.side,
                count: request.count ?? 1,
            });
            await controller.drain();
            return [...messages()].reverse().find((message) =>
                message.type === 'structuralInsertResult' && message.requestId === request.requestId) as never;
        },
        async insertColumns(request) {
            await panel.__receive({
                type: 'requestStructuralInsert',
                requestId: request.requestId,
                editSessionId: session_id()!,
                worksheet: { sheetIndex: 0, sheetName: sheet_name(0) },
                sourceGeneration: snapshot().sourceGeneration,
                axis: 'columns',
                anchor: { column: { kind: 'source', sourceColumn: request.anchor } },
                side: request.side,
                count: request.count ?? 1,
            });
            await controller.drain();
            return [...messages()].reverse().find((message) =>
                message.type === 'structuralInsertResult' && message.requestId === request.requestId) as never;
        },
        async append(request_id, count) {
            await panel.__receive({
                type: 'requestAppendRows',
                requestId: request_id,
                editSessionId: session_id()!,
                worksheet: { sheetIndex: 0, sheetName: sheet_name(0) },
                sourceGeneration: snapshot().sourceGeneration,
                count,
            });
            await controller.drain();
            return [...messages()].reverse().find((message) =>
                message.type === 'appendRowsResult' && message.requestId === request_id) as never;
        },
        async settle(request_id, accepted) {
            await panel.__receive({ type: 'settleRowAdmission', requestId: request_id, editSessionId: session_id()!, accepted });
            await controller.drain();
        },
        async publish(sheet_index, changes) {
            sequence += 1;
            const at = sequence;
            await panel.__receive({
                type: 'pendingChangesChanged',
                editSessionId: session_id()!,
                sequence: at,
                sourceGeneration: snapshot().sourceGeneration,
                changes: {
                    sheetIndex: sheet_index,
                    sheetName: sheet_name(sheet_index),
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
        async save(worksheets) {
            save_sequence += 1;
            const save_request_id = `save-${save_sequence}`;
            await panel.__receive({
                type: 'saveCsv',
                operation: {
                    editSessionId: session_id()!,
                    saveRequestId: save_request_id,
                    worksheets: worksheets.map(({ sheetIndex, structural, cells = {} }) => ({
                        sheetIndex,
                        sheetName: sheet_name(sheetIndex),
                        edits: Object.fromEntries(Object.entries(cells).map(([key, entry]) => [key, entry.value])),
                        dirtyEdits: cells,
                        ...(structural === undefined ? {} : {
                            structuralChanges: {
                                formatTemplates: [],
                                appendedRows: [],
                                tailRemovals: [],
                                conflicts: [],
                                ...structural,
                            },
                        }),
                    })),
                },
            });
            await controller.drain();
            // This request's own result, never an earlier save's.
            const result = [...messages()].reverse().find((message) =>
                message.type === 'saveResult'
                && (message.lifecycle as { operation?: { saveRequestId?: string } } | undefined)
                    ?.operation?.saveRequestId === save_request_id);
            if (result === undefined) throw new Error(`No saveResult arrived for ${save_request_id}.`);
            return result as never;
        },
        async replay(id, cells) {
            const worksheet = { sheetIndex: 0, sheetName: sheet_name(0) };
            const latest = last<{ snapshot: { identity: unknown } }>('workbookSnapshot');
            await panel.__receive({ type: 'snapshotApplied', identity: latest.snapshot.identity, disposition: 'applied' });
            await panel.__receive({
                type: 'prepareHistoryReplay',
                request: {
                    requestId: `${id}-prepare`,
                    replayId: id,
                    cells,
                    highlights: [],
                    structures: [],
                    focus: { worksheet, sourceRowStart: 0, sourceRowEnd: 0, sourceColumnStart: 0, sourceColumnEnd: 0 },
                },
            });
            await controller.drain();
            const prepared = (messages().find((message) => message.type === 'historyReplayPrepared'
                && (message as { prepared?: { replayId?: string } }).prepared?.replayId === id) as {
                prepared?: { requestId: string; replayId: string; leaseId: string };
            } | undefined)?.prepared;
            if (prepared === undefined) return undefined;
            await panel.__receive({
                type: 'commitHistoryReplay',
                request: {
                    requestId: prepared.requestId,
                    replayId: prepared.replayId,
                    leaseId: prepared.leaseId,
                    mutationId: `${id}-mutation`,
                    cells: cells.map((_cell, ordinal) => ({ ordinal, entry: null })),
                    highlights: [],
                    structures: [],
                },
            });
            await controller.drain();
            return messages().find((message) => message.type === 'historyReplayCommitted'
                && (message as { committed?: { replayId?: string } }).committed?.replayId === id);
        },
    };
}

export function part_text(bytes: Uint8Array, path: string): string | null {
    return ZipPackage.open(bytes).read_text(`/${path}`);
}

