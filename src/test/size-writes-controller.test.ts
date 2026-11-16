/**
 * The host's size writes as undo history needs them: `setColumnWidths`,
 * `setRowHeights` (a resize, or a reset with `height: null`), and
 * `setSourceRowHeights`.
 *
 * Each is answered on every exit. `applied` says the durable state holds what
 * was asked, decided by the write alone; the answer follows a delivery of what
 * is durable; and a gesture's answer carries what the write actually changed,
 * which is the step undo history records.
 *
 * `row-heights-controller.test.ts` covers a resize's mapping, clamping, bounds
 * and currency; this file covers what an answered request adds.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as vscode from 'vscode';
import { attach_viewer, csv_table_profile } from '../viewer-controller';
import type { FileStateStore } from '../state';
import {
    MAX_PERSISTED_ROW_HEIGHTS,
    type HostMessage,
    type PerFileState,
    type StoredPerFileState,
    type WebviewMessage,
} from '../types';
import type { DataSource, RenderedCell, RowWindow, WorkbookMeta } from '../data-source/interface';
import type { WorkbookSnapshot } from '../viewer-snapshot';
import { with_in_memory_authority_transactions } from '../state-authority';
import { versioned_state_store } from './helpers/versioned-state-store';
import * as vscode_mock from './mocks/vscode';
import { fake_viewer_host } from './mocks/host-ports';

const enc = new TextEncoder();
const file_path = '/tmp/size-writes-controller.csv';

/** Header `h,i`, then rows `c`, `a`, `b` at source rows 0, 1, 2. */
const CSV = 'h,i\nc,1\na,2\nb,3\n';

type Panel = ReturnType<typeof vscode_mock.window.createWebviewPanel>;
type AuthorityStore = ReturnType<typeof with_in_memory_authority_transactions>;

function deferred() {
    let resolve!: () => void;
    const promise = new Promise<void>((done) => { resolve = done; });
    return { promise, resolve };
}

/** Open the CSV over `store`. `store` is used as given, so a test can gate it outside the per-file queue. */
function open_csv(store: AuthorityStore): Panel {
    const panel = vscode_mock.window.createWebviewPanel('tableViewer.editor', 'table');
    const controller = attach_viewer(
        panel as unknown as Parameters<typeof attach_viewer>[0],
        vscode_mock.Uri.file(file_path) as unknown as vscode.Uri,
        store,
        csv_table_profile(),
        fake_viewer_host,
    );
    panel.onDidDispose(() => controller.dispose());
    return panel;
}

/** A two-sheet workbook, three rows and two columns each. */
class TwoSheetSource implements DataSource {
    meta(): WorkbookMeta {
        return {
            hasFormatting: false,
            sheets: ['Sheet1', 'Sheet2'].map((name) => ({
                name,
                rowCount: 3,
                sourceRowCount: 3,
                columnCount: 2,
                merges: [],
                hasFormatting: false,
            })),
        };
    }

    read_rows(_sheet: number, start: number, count: number): RowWindow {
        const values = ['c', 'a', 'b'];
        const clamped = Math.max(0, Math.min(start, values.length));
        const rows: (RenderedCell | null)[][] = values.slice(clamped, clamped + count)
            .map((raw) => [
                { raw, formatted: raw, bold: false, italic: false },
                { raw: '1', formatted: '1', bold: false, italic: false },
            ]);
        return { startRow: clamped, rows };
    }

    close(): void {}
}

function open_two_sheets(store: AuthorityStore): Panel {
    const panel = vscode_mock.window.createWebviewPanel('tableViewer.editor', 'table');
    const controller = attach_viewer(
        panel as unknown as Parameters<typeof attach_viewer>[0],
        vscode_mock.Uri.file(file_path) as unknown as vscode.Uri,
        store,
        { editing: false, async build_source() { return new TwoSheetSource(); } },
        fake_viewer_host,
    );
    panel.onDidDispose(() => controller.dispose());
    return panel;
}

function messages_of<T extends HostMessage['type']>(
    panel: { __messages: unknown[] },
    type: T,
): Array<Extract<HostMessage, { type: T }>> {
    return panel.__messages.filter((message): message is Extract<HostMessage, { type: T }> => (
        typeof message === 'object' && message !== null && 'type' in message && message.type === type
    ));
}

/** The types posted since `from`, in order: deliveries and answers. */
function posts_since(panel: { __messages: unknown[] }, from: number): string[] {
    return panel.__messages.slice(from)
        .map((message) => (message as { type: string }).type)
        .filter((type) => type === 'workbookSnapshot'
            || type === 'columnWidthsChanged'
            || type === 'rowHeightsChanged');
}

async function ready(panel: Panel): Promise<WorkbookSnapshot> {
    await panel.__receive({ type: 'ready' });
    await vi.waitFor(() => expect(messages_of(panel, 'workbookSnapshot').length).toBeGreaterThan(0));
    // The delivery is acknowledged by a microtask; let it land.
    await new Promise((resolve) => setTimeout(resolve, 0));
    return messages_of(panel, 'workbookSnapshot').at(-1)!.snapshot;
}

const latest_snapshot = (panel: Panel) => messages_of(panel, 'workbookSnapshot').at(-1)!.snapshot;

let request_sequence = 0;
const next_id = (prefix: string) => `${prefix}-${++request_sequence}`;

async function set_widths(
    panel: Panel,
    basis: Pick<WorkbookSnapshot, 'sourceGeneration'>,
    sheets: Extract<WebviewMessage, { type: 'setColumnWidths' }>['sheets'],
) {
    const requestId = next_id('widths');
    await panel.__receive({
        type: 'setColumnWidths',
        requestId,
        sourceGeneration: basis.sourceGeneration,
        sheets,
    } satisfies Extract<WebviewMessage, { type: 'setColumnWidths' }>).catch(() => undefined);
    await vi.waitFor(() => expect(messages_of(panel, 'columnWidthsChanged')
        .some((answer) => answer.requestId === requestId)).toBe(true));
    return messages_of(panel, 'columnWidthsChanged').find((answer) => answer.requestId === requestId)!;
}

const on_sheet1 = (widths: { column: number; width: number | null }[]) =>
    [{ sheetIndex: 0, sheetName: 'Sheet1', widths }];

async function resize_rows(
    panel: Panel,
    basis: Pick<WorkbookSnapshot, 'generation' | 'sourceGeneration'>,
    rows: { start: number; end: number }[],
    height: number | null,
) {
    const requestId = next_id('rows');
    await panel.__receive({
        type: 'setRowHeights',
        sheetIndex: 0,
        rows,
        height,
        generation: basis.generation,
        sourceGeneration: basis.sourceGeneration,
        requestId,
    } satisfies Extract<WebviewMessage, { type: 'setRowHeights' }>).catch(() => undefined);
    await vi.waitFor(() => expect(messages_of(panel, 'rowHeightsChanged')
        .some((answer) => answer.requestId === requestId)).toBe(true));
    return messages_of(panel, 'rowHeightsChanged').find((answer) => answer.requestId === requestId)!;
}

async function set_source_rows(
    panel: Panel,
    basis: Pick<WorkbookSnapshot, 'sourceGeneration'>,
    rows: { start: number; end: number; height: number | null }[],
    sheetName = 'Sheet1',
) {
    const requestId = next_id('source-rows');
    await panel.__receive({
        type: 'setSourceRowHeights',
        requestId,
        sheetIndex: 0,
        sheetName,
        sourceGeneration: basis.sourceGeneration,
        rows,
    } satisfies Extract<WebviewMessage, { type: 'setSourceRowHeights' }>).catch(() => undefined);
    await vi.waitFor(() => expect(messages_of(panel, 'rowHeightsChanged')
        .some((answer) => answer.requestId === requestId)).toBe(true));
    return messages_of(panel, 'rowHeightsChanged').find((answer) => answer.requestId === requestId)!;
}

/** Sort ascending on column 0: display order (a, b, c) is source order (1, 2, 0). */
async function sort_ascending(panel: Panel, basis: Pick<WorkbookSnapshot, 'generation' | 'sourceGeneration'>) {
    const requestId = next_id('sort');
    await panel.__receive({
        type: 'setTransform',
        sheetIndex: 0,
        requestId,
        generation: basis.generation,
        sourceGeneration: basis.sourceGeneration,
        intent: 'user',
        state: { sort: [{ colIndex: 0, direction: 'asc' }], filters: [], schema: '["Sheet1",2,["h","i"]]' },
    } satisfies Extract<WebviewMessage, { type: 'setTransform' }>);
    await vi.waitFor(() => expect(messages_of(panel, 'transformInstalled')
        .some((ack) => ack.requestId === requestId)).toBe(true));
    return messages_of(panel, 'transformInstalled').find((ack) => ack.requestId === requestId)!;
}

const queued = (store: FileStateStore) => with_in_memory_authority_transactions(store);

function warnings(): string[] {
    return vi.mocked(vscode_mock.window.showWarningMessage).mock.calls.map((call) => String(call[0]));
}

beforeEach(() => {
    for (const panel of vscode_mock.__getPanels()) panel.dispose();
    vi.restoreAllMocks();
    vscode_mock.__reset();
    vi.spyOn(vscode_mock.window, 'showWarningMessage');
    vscode_mock.__setStatImplementation(async () => ({ size: CSV.length, mtime: 1 }));
    vscode_mock.__setReadFileImplementation(async () => enc.encode(CSV));
});

describe('setColumnWidths', () => {
    it('stores the widths, delivers them, then answers with what it changed', async () => {
        const state = versioned_state_store({ columnWidths: [{ 0: 100 }] });
        const panel = open_csv(queued(state.store));
        const initial = await ready(panel);
        const from = panel.__messages.length;

        const answer = await set_widths(panel, initial, on_sheet1([
            { column: 1, width: 180 },
            { column: 0, width: 90 },
        ]));

        expect(answer).toMatchObject({
            applied: true,
            change: [{
                sheetIndex: 0,
                columns: [
                    { column: 0, before: 100, after: 90 },
                    { column: 1, before: null, after: 180 },
                ],
            }],
        });
        expect(state.get_state(file_path).columnWidths).toEqual([{ 0: 90, 1: 180 }]);
        // The delivery first, so the answer never overtakes the state it reports.
        expect(posts_since(panel, from)).toEqual(['workbookSnapshot', 'columnWidthsChanged']);
        expect(latest_snapshot(panel).state.columnWidths).toEqual([{ 0: 90, 1: 180 }]);
    });

    it('reports the stored width as what it replaced, whatever the window believed', async () => {
        // Another window stored 200 since this panel's snapshot, which still
        // shows 100. Undoing this resize has to put 200 back.
        const state = versioned_state_store({ columnWidths: [{ 0: 100 }] });
        const panel = open_csv(queued(state.store));
        const initial = await ready(panel);
        await state.store.compare_and_set(file_path, state.revision(file_path), { columnWidths: [{ 0: 200 }] });

        const answer = await set_widths(panel, initial, on_sheet1([{ column: 0, width: 180 }]));

        expect(answer.change).toEqual([{ sheetIndex: 0, columns: [{ column: 0, before: 200, after: 180 }] }]);
    });

    it('answers applied with nothing changed, and delivers the stored widths, for a no-op', async () => {
        // The panel holds 100; another window has stored 200. Dragging to 200
        // writes nothing: no step, and the delivery must not send 100 back.
        const state = versioned_state_store({ columnWidths: [{ 0: 100 }] });
        const panel = open_csv(queued(state.store));
        const initial = await ready(panel);
        expect(initial.state.columnWidths).toEqual([{ 0: 100 }]);
        await state.store.compare_and_set(file_path, state.revision(file_path), { columnWidths: [{ 0: 200 }] });
        const revision = state.revision(file_path);
        const from = panel.__messages.length;

        const answer = await set_widths(panel, initial, on_sheet1([{ column: 0, width: 200 }]));

        expect(answer).toMatchObject({ applied: true, change: [] });
        expect(state.revision(file_path)).toBe(revision);
        expect(posts_since(panel, from)).toEqual(['workbookSnapshot', 'columnWidthsChanged']);
        expect(latest_snapshot(panel).state.columnWidths).toEqual([{ 0: 200 }]);
    });

    it('removes a stored width with null, and clamps what it stores', async () => {
        const state = versioned_state_store({ columnWidths: [{ 0: 100, 1: 150 }] });
        const panel = open_csv(queued(state.store));
        const initial = await ready(panel);

        const answer = await set_widths(panel, initial, on_sheet1([
            { column: 0, width: null },
            { column: 1, width: 1 },
        ]));

        expect(answer.change).toEqual([{
            sheetIndex: 0,
            columns: [
                { column: 0, before: 100, after: null },
                { column: 1, before: 150, after: 40 },
            ],
        }]);
        expect(state.get_state(file_path).columnWidths).toEqual([{ 1: 40 }]);
        // The last width gone leaves no map at all.
        await set_widths(panel, latest_snapshot(panel), on_sheet1([{ column: 1, width: null }]));
        expect(state.get_state(file_path).columnWidths).toEqual([undefined]);
    });

    it('writes several worksheets in one compare-and-set, or none', async () => {
        const state = versioned_state_store();
        const panel = open_two_sheets(queued(state.store));
        const initial = await ready(panel);
        const revision = state.revision(file_path);

        const answer = await set_widths(panel, initial, [
            { sheetIndex: 0, sheetName: 'Sheet1', widths: [{ column: 0, width: 90 }] },
            { sheetIndex: 1, sheetName: 'Sheet2', widths: [{ column: 1, width: 70 }] },
        ]);

        expect(answer).toMatchObject({
            applied: true,
            change: [
                { sheetIndex: 0, columns: [{ column: 0, before: null, after: 90 }] },
                { sheetIndex: 1, columns: [{ column: 1, before: null, after: 70 }] },
            ],
        });
        expect(state.revision(file_path)).toBe(revision + 1);
        expect(state.get_state(file_path).columnWidths).toEqual([{ 0: 90 }, { 1: 70 }]);

        // One worksheet named wrongly refuses the whole request.
        const refused = await set_widths(panel, latest_snapshot(panel), [
            { sheetIndex: 0, sheetName: 'Sheet1', widths: [{ column: 0, width: 300 }] },
            { sheetIndex: 1, sheetName: 'Renamed', widths: [{ column: 1, width: 300 }] },
        ]);
        expect(refused.applied).toBe(false);
        expect(state.get_state(file_path).columnWidths).toEqual([{ 0: 90 }, { 1: 70 }]);
    });

    it.each([
        ['another source generation', (basis: WorkbookSnapshot) => ({
            basis: { sourceGeneration: basis.sourceGeneration + 1 },
            sheets: on_sheet1([{ column: 0, width: 90 }]),
        })],
        ['a worksheet name that does not match', (basis: WorkbookSnapshot) => ({
            basis,
            sheets: [{ sheetIndex: 0, sheetName: 'Other', widths: [{ column: 0, width: 90 }] }],
        })],
        ['a column the worksheet does not have', (basis: WorkbookSnapshot) => ({
            basis,
            sheets: on_sheet1([{ column: 2, width: 90 }]),
        })],
        ['a width that is not a number', (basis: WorkbookSnapshot) => ({
            basis,
            sheets: on_sheet1([{ column: 0, width: Number.NaN }]),
        })],
    ])('answers not applied, writing and delivering nothing, for %s', async (_name, request) => {
        const state = versioned_state_store({ columnWidths: [{ 0: 100 }] });
        const panel = open_csv(queued(state.store));
        const initial = await ready(panel);
        const revision = state.revision(file_path);
        const from = panel.__messages.length;
        const { basis, sheets } = request(initial);

        const answer = await set_widths(panel, basis, sheets);

        expect(answer.applied).toBe(false);
        expect(answer.change).toBeUndefined();
        expect(state.revision(file_path)).toBe(revision);
        expect(posts_since(panel, from)).toEqual(['columnWidthsChanged']);
    });

    it('answers not applied when the store throws in the write', async () => {
        const versioned = versioned_state_store();
        let fail = false;
        const panel = open_csv(queued({
            ...versioned.store,
            async compare_and_set(path, expected, next, validate, basis) {
                if (fail) throw new Error('disk full');
                return versioned.store.compare_and_set(path, expected, next, validate, basis);
            },
        }));
        const initial = await ready(panel);
        fail = true;

        const answer = await set_widths(panel, initial, on_sheet1([{ column: 0, width: 90 }]));

        expect(answer.applied).toBe(false);
        expect(versioned.get_state(file_path).columnWidths).toBeUndefined();
    });

    it('answers applied when the write committed and the read after it throws', async () => {
        // The verdict is the write's. A failure delivering it must not turn a
        // durable resize into "nothing was written".
        const versioned = versioned_state_store();
        let committed = false;
        const panel = open_csv(queued({
            ...versioned.store,
            async read(path) {
                if (committed) throw new Error('read failed');
                return versioned.store.read(path);
            },
            async compare_and_set(path, expected, next, validate, basis) {
                const result = await versioned.store.compare_and_set(path, expected, next, validate, basis);
                if (result.type === 'committed' && next.columnWidths?.[0]) committed = true;
                return result;
            },
        }));
        const initial = await ready(panel);

        const answer = await set_widths(panel, initial, on_sheet1([{ column: 0, width: 90 }]));

        expect(answer).toMatchObject({
            applied: true,
            change: [{ sheetIndex: 0, columns: [{ column: 0, before: null, after: 90 }] }],
        });
        expect(versioned.get_state(file_path).columnWidths).toEqual([{ 0: 90 }]);
    });

    it('is applied while a delivery is unacknowledged', async () => {
        // The case that loses a resize sent through `stateChanged`: a delivery
        // is out, the window has not acknowledged it, and the host refuses the
        // whole-state message for naming the snapshot before it.
        const state = versioned_state_store();
        const panel = open_csv(queued(state.store));
        const initial = await ready(panel);
        panel.__autoAckSnapshots = false;
        await set_widths(panel, initial, on_sheet1([{ column: 0, width: 90 }]));

        const answer = await set_widths(panel, initial, on_sheet1([{ column: 1, width: 70 }]));

        expect(answer.applied).toBe(true);
        expect(state.get_state(file_path).columnWidths).toEqual([{ 0: 90, 1: 70 }]);
    });

    it('cannot be written through stateChanged', async () => {
        const state = versioned_state_store({ columnWidths: [{ 0: 100 }] });
        const panel = open_csv(queued(state.store));
        const initial = await ready(panel);

        await panel.__receive({
            type: 'stateChanged',
            sourceGeneration: initial.sourceGeneration,
            snapshotIdentity: initial.identity,
            state: { ...initial.state, columnWidths: [{ 0: 300, 1: 300 }], scrollPosition: [{ top: 9, left: 0 }] },
        });

        const durable = state.get_state(file_path) as PerFileState;
        expect(durable.scrollPosition).toEqual([{ top: 9, left: 0 }]);
        expect(durable.columnWidths).toEqual([{ 0: 100 }]);
    });
});

describe('setRowHeights, answered', () => {
    it('says which source rows changed and what each held', async () => {
        const state = versioned_state_store({ rowHeights: [{ 2: 40 }] } as StoredPerFileState);
        const panel = open_csv(queued(state.store));
        const initial = await ready(panel);
        const sorted = await sort_ascending(panel, initial);
        const from = panel.__messages.length;

        // Display rows 0..2 under the sort are source rows 1, 2, 0.
        const answer = await resize_rows(panel, sorted.view.basis, [{ start: 0, end: 2 }], 60);

        expect(answer).toMatchObject({
            applied: true,
            change: {
                height: 60,
                // Rows 0 and 1 had no custom height and are one run; row 2 held 40.
                before: [{ start: 0, end: 1, height: null }, { start: 2, end: 2, height: 40 }],
            },
        });
        expect(state.get_state(file_path).rowHeights).toEqual([{ 0: 60, 1: 60, 2: 60 }]);
        expect(posts_since(panel, from)).toEqual(['workbookSnapshot', 'rowHeightsChanged']);
    });

    it('leaves out rows already at the height, and is empty for a no-op', async () => {
        const state = versioned_state_store({ rowHeights: [{ 1: 60 }] } as StoredPerFileState);
        const panel = open_csv(queued(state.store));
        const initial = await ready(panel);

        const partial = await resize_rows(panel, initial, [{ start: 0, end: 2 }], 60);
        expect(partial.change).toEqual({
            height: 60,
            before: [{ start: 0, end: 0, height: null }, { start: 2, end: 2, height: null }],
        });

        const revision = state.revision(file_path);
        const again = await resize_rows(panel, latest_snapshot(panel), [{ start: 0, end: 2 }], 60);
        expect(again).toMatchObject({ applied: true, change: { height: 60, before: [] } });
        expect(state.revision(file_path)).toBe(revision);
    });

    it('resets the named rows that hold a height, whatever order the request names them in', async () => {
        const state = versioned_state_store({ rowHeights: [{ 0: 50, 1: 60, 2: 70 }] } as StoredPerFileState);
        const panel = open_csv(queued(state.store));
        const initial = await ready(panel);
        const sorted = await sort_ascending(panel, initial);

        // Display rows 0 and 2, out of order and overlapping: source rows 1 and 0.
        const answer = await resize_rows(
            panel,
            sorted.view.basis,
            [{ start: 2, end: 2 }, { start: 0, end: 0 }, { start: 0, end: 0 }],
            null,
        );

        expect(answer).toMatchObject({
            applied: true,
            change: { height: null, before: [{ start: 0, end: 0, height: 50 }, { start: 1, end: 1, height: 60 }] },
        });
        expect(state.get_state(file_path).rowHeights).toEqual([{ 2: 70 }]);
        // The last one gone leaves no map.
        await resize_rows(panel, latest_snapshot(panel), [{ start: 0, end: 2 }], null);
        expect(state.get_state(file_path).rowHeights).toEqual([undefined]);
    });

    it('resets without the request cap, which only bounds what a resize may add', async () => {
        const state = versioned_state_store({ rowHeights: [{ 1: 60 }] } as StoredPerFileState);
        const panel = open_csv(queued(state.store));
        const initial = await ready(panel);

        // More rows than a resize may name, as a select-all on a long sheet would.
        const answer = await resize_rows(panel, initial, [{ start: 0, end: MAX_PERSISTED_ROW_HEIGHTS + 5 }], null);

        expect(answer).toMatchObject({
            applied: true,
            change: { height: null, before: [{ start: 1, end: 1, height: 60 }] },
        });
        expect(warnings()).toEqual([]);
    });

    it('answers applied for a write that committed before the mapping moved', async () => {
        // The compare-and-set commits; before the handler resumes, a sort
        // installs and this sheet's mapping generation passes the request's.
        // The heights are durable, so the answer must not say otherwise.
        const versioned = versioned_state_store();
        const committed = deferred();
        const resume = deferred();
        let hold = true;
        const inner = queued(versioned.store);
        const panel = open_csv({
            ...inner,
            async compare_and_set(path, expected, next, validate, basis) {
                const result = await inner.compare_and_set(path, expected, next, validate, basis);
                if (hold && next.rowHeights?.[0] && result.type === 'committed') {
                    hold = false;
                    committed.resolve();
                    await resume.promise;
                }
                return result;
            },
        });
        const initial = await ready(panel);

        const requestId = next_id('rows');
        const resizing = panel.__receive({
            type: 'setRowHeights',
            sheetIndex: 0,
            rows: [{ start: 0, end: 0 }],
            height: 60,
            generation: initial.generation,
            sourceGeneration: initial.sourceGeneration,
            requestId,
        });
        await committed.promise;
        await sort_ascending(panel, initial);
        resume.resolve();
        await resizing;

        await vi.waitFor(() => expect(messages_of(panel, 'rowHeightsChanged')
            .find((answer) => answer.requestId === requestId)).toMatchObject({
            applied: true,
            change: { height: 60, before: [{ start: 0, end: 0, height: null }] },
        }));
        expect(versioned.get_state(file_path).rowHeights).toEqual([{ 0: 60 }]);
    });

    it('answers not applied when the store throws, instead of nothing', async () => {
        const versioned = versioned_state_store();
        let fail = false;
        const panel = open_csv(queued({
            ...versioned.store,
            async compare_and_set(path, expected, next, validate, basis) {
                if (fail) throw new Error('disk full');
                return versioned.store.compare_and_set(path, expected, next, validate, basis);
            },
        }));
        const initial = await ready(panel);
        fail = true;

        const answer = await resize_rows(panel, initial, [{ start: 0, end: 0 }], 60);

        expect(answer.applied).toBe(false);
    });
});

describe('setRowHeights, when the read after its commit fails', () => {
    it('still answers applied, with what it changed', async () => {
        // The verdict is the write's: a failure delivering it must not turn a
        // durable resize into "nothing was written", or the step is lost.
        const versioned = versioned_state_store();
        let committed = false;
        const panel = open_csv(queued({
            ...versioned.store,
            async read(path) {
                if (committed) throw new Error('read failed');
                return versioned.store.read(path);
            },
            async compare_and_set(path, expected, next, validate, basis) {
                const result = await versioned.store.compare_and_set(path, expected, next, validate, basis);
                if (result.type === 'committed' && next.rowHeights?.[0]) committed = true;
                return result;
            },
        }));
        const initial = await ready(panel);

        const answer = await resize_rows(panel, initial, [{ start: 1, end: 1 }], 60);

        expect(answer).toMatchObject({
            applied: true,
            change: { height: 60, before: [{ start: 1, end: 1, height: null }] },
        });
        expect(versioned.get_state(file_path).rowHeights).toEqual([{ 1: 60 }]);
    });
});

describe('setSourceRowHeights', () => {
    it('sets and removes heights by source row, delivers, then answers', async () => {
        const state = versioned_state_store({ rowHeights: [{ 0: 50, 2: 70 }] } as StoredPerFileState);
        const panel = open_csv(queued(state.store));
        const initial = await ready(panel);
        // A sort makes no difference: the rows are named by source row.
        await sort_ascending(panel, initial);
        const from = panel.__messages.length;

        const answer = await set_source_rows(panel, initial, [
            { start: 0, end: 0, height: null },
            { start: 1, end: 2, height: 44 },
        ]);

        expect(answer.applied).toBe(true);
        expect(answer.change).toBeUndefined();
        expect(state.get_state(file_path).rowHeights).toEqual([{ 1: 44, 2: 44 }]);
        expect(posts_since(panel, from)).toEqual(['workbookSnapshot', 'rowHeightsChanged']);
        // Display rows under the sort: source 1 is display 0, source 2 is display 1.
        expect(latest_snapshot(panel).rowHeightProjection).toEqual([{ 0: 44, 1: 44 }]);
    });

    it('answers applied for rows already as asked, with a delivery', async () => {
        const state = versioned_state_store({ rowHeights: [{ 1: 44 }] } as StoredPerFileState);
        const panel = open_csv(queued(state.store));
        const initial = await ready(panel);
        const revision = state.revision(file_path);
        const from = panel.__messages.length;

        const answer = await set_source_rows(panel, initial, [
            { start: 0, end: 0, height: null },
            { start: 1, end: 1, height: 44 },
        ]);

        expect(answer.applied).toBe(true);
        expect(state.revision(file_path)).toBe(revision);
        expect(posts_since(panel, from)).toEqual(['workbookSnapshot', 'rowHeightsChanged']);
    });

    it.each([
        ['a row past the end of the worksheet', [{ start: 2, end: 3, height: 44 }], 'Sheet1'],
        ['a run that ends before it starts', [{ start: 2, end: 1, height: 44 }], 'Sheet1'],
        ['a height that is not a number', [{ start: 0, end: 0, height: Number.NaN }], 'Sheet1'],
        ['a worksheet name that does not match', [{ start: 0, end: 0, height: 44 }], 'Other'],
    ])('answers not applied and writes nothing for %s', async (_name, rows, sheet_name) => {
        const state = versioned_state_store();
        const panel = open_csv(queued(state.store));
        const initial = await ready(panel);

        const answer = await set_source_rows(panel, initial, rows, sheet_name);

        expect(answer.applied).toBe(false);
        expect(answer.refused).toBeUndefined();
        expect(state.get_state(file_path).rowHeights).toBeUndefined();
    });

    it('says the worksheet would hold too many custom heights, and shows no warning itself', async () => {
        // A map already at the bound: one more row would grow it.
        const full: Record<number, number> = {};
        for (let row = 0; row < MAX_PERSISTED_ROW_HEIGHTS; row += 1) full[row + 1] = 30;
        const state = versioned_state_store({ rowHeights: [full] } as StoredPerFileState);
        const panel = open_csv(queued(state.store));
        const initial = await ready(panel);

        const answer = await set_source_rows(panel, initial, [{ start: 0, end: 0, height: 44 }]);

        expect(answer).toMatchObject({ applied: false, refused: 'limit' });
        // The window says what its undo or redo did; a second warning from the
        // host would be noise.
        expect(warnings()).toEqual([]);
        // A write that does not grow the map is not refused.
        const removed = await set_source_rows(panel, initial, [{ start: 1, end: 1, height: null }]);
        expect(removed.applied).toBe(true);
    });

    it('is applied while a delivery is unacknowledged', async () => {
        const state = versioned_state_store();
        const panel = open_csv(queued(state.store));
        const initial = await ready(panel);
        panel.__autoAckSnapshots = false;
        await set_source_rows(panel, initial, [{ start: 0, end: 0, height: 44 }]);

        const answer = await set_source_rows(panel, initial, [{ start: 1, end: 1, height: 55 }]);

        expect(answer.applied).toBe(true);
        expect(state.get_state(file_path).rowHeights).toEqual([{ 0: 44, 1: 55 }]);
    });

    it('answers by where the write got to when the store throws', async () => {
        const versioned = versioned_state_store();
        let fail_write = false;
        let fail_read_after_commit = false;
        let committed = false;
        const panel = open_csv(queued({
            ...versioned.store,
            async read(path) {
                if (fail_read_after_commit && committed) throw new Error('read failed');
                return versioned.store.read(path);
            },
            async compare_and_set(path, expected, next, validate, basis) {
                if (fail_write) throw new Error('disk full');
                const result = await versioned.store.compare_and_set(path, expected, next, validate, basis);
                if (result.type === 'committed') committed = true;
                return result;
            },
        }));
        const initial = await ready(panel);

        fail_write = true;
        expect((await set_source_rows(panel, initial, [{ start: 0, end: 0, height: 44 }])).applied).toBe(false);

        fail_write = false;
        committed = false;
        fail_read_after_commit = true;
        expect((await set_source_rows(panel, initial, [{ start: 0, end: 0, height: 44 }])).applied).toBe(true);
        expect(versioned.get_state(file_path).rowHeights).toEqual([{ 0: 44 }]);
    });
});
