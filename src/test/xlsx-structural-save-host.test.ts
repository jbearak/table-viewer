// `.xlsx` structural editing through the controller (row and column
// structure design, delivery step 9c): the capability the snapshot ships,
// insert admission with an anchor-row format template, and saves that delete,
// insert, append, and edit in combination, checked against the written
// package, the receipt, the rekey, and `parse_xlsx`.
import { afterEach, describe, expect, it, vi } from 'vitest';
import type * as vscode from 'vscode';
import {
    attach_viewer,
    profile_for,
    simulate_process_restart_for_tests,
} from '../viewer-controller';
import { with_in_memory_authority_transactions } from '../state-authority';
import type { PerFileState, WorksheetPendingEdits } from '../types';
import type { PendingAppendedRow, PendingRowFormatTemplate, StructuralBasis } from '../pending-changes';
import type { StructuralEditingCapability } from '../viewer-snapshot';
import { content_digest } from '../content-digest';
import { parse_xlsx } from '../parse-xlsx';
import { ZipPackage } from '../zip-package';
import { versioned_state_store } from './helpers/versioned-state-store';
import { build_fixture_xlsx, cell, representative_workbook, row } from './helpers/xlsx-structure-fixture';
import * as vscode_mock from './mocks/vscode';
import { fake_viewer_host } from './mocks/host-ports';

const FILE = '/tmp/xlsx-structural-save-host.xlsx';

afterEach(() => {
    for (const panel of vscode_mock.__getPanels()) panel.dispose();
    vi.restoreAllMocks();
    vscode_mock.__reset();
    simulate_process_restart_for_tests();
});

type Message = { type?: string } & Record<string, unknown>;

function disk(initial: Uint8Array) {
    const file = { bytes: initial, mtime: 1, writes: [] as Uint8Array[] };
    vscode_mock.__setStatImplementation(async () => ({ size: file.bytes.length, mtime: file.mtime }));
    vscode_mock.__setReadFileImplementation(async () => file.bytes);
    vscode_mock.__setWriteFileImplementation(async (_uri, content) => {
        file.writes.push(content);
        file.bytes = content;
        file.mtime += 1;
    });
    return file;
}

export interface OpenXlsx {
    readonly file: ReturnType<typeof disk>;
    readonly messages: () => Message[];
    readonly warning: ReturnType<typeof vi.spyOn>;
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
}

export async function open_xlsx(bytes: Uint8Array, options: { readonly state?: PerFileState } = {}): Promise<OpenXlsx> {
    const file = disk(bytes);
    const state = versioned_state_store(options.state ?? {});
    const panel = vscode_mock.window.createWebviewPanel('tableViewer.editor', 'table');
    const controller = attach_viewer(
        panel as unknown as Parameters<typeof attach_viewer>[0],
        vscode_mock.Uri.file(FILE) as unknown as vscode.Uri,
        with_in_memory_authority_transactions(state.store),
        profile_for(FILE),
        fake_viewer_host,
        { structuralEditingEnabled: true },
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
    return {
        file,
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
            await panel.__receive({
                type: 'saveCsv',
                operation: {
                    editSessionId: session_id()!,
                    saveRequestId: `save-${Math.random()}`,
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
            return last('saveResult');
        },
    };
}

export function part_text(bytes: Uint8Array, path: string): string | null {
    return ZipPackage.open(bytes).read_text(`/${path}`);
}

const HEADER_ON: PerFileState = { excelFirstRowHeaders: { Data: 'on' } };

/** Every `<row>` of a worksheet part, as `r` → inner XML, for compact assertions. */
function rows_of(xml: string): Map<number, { readonly open: string; readonly inner: string }> {
    const out = new Map<number, { open: string; inner: string }>();
    for (const match of xml.matchAll(/<row\b([^>]*?)(?:\/>|>([\s\S]*?)<\/row>)/g)) {
        const number = Number(/\br="(\d+)"/.exec(match[1]!)![1]);
        out.set(number, { open: match[1]!, inner: match[2] ?? '' });
    }
    return out;
}

function cell_values(rows: readonly (readonly unknown[])[]): unknown[][] {
    return rows.map((cells) => cells.map((value) => {
        if (value === null || value === undefined) return null;
        if (typeof value === 'object' && 'raw' in (value as object)) return (value as { raw: unknown }).raw;
        return value;
    }));
}

/**
 * Data, Header Row 1, body source rows 1-6 (Apple … Fig). The save deletes
 * Banana (source row 2), inserts Grape after Date (source row 4), appends
 * Kiwi, and edits Cherry's quantity.
 */
async function delete_insert_append(viewer: OpenXlsx) {
    const insert = await viewer.insert({ requestId: 'insert', anchor: 4, side: 'after' });
    expect(insert).toMatchObject({ granted: true });
    await viewer.settle('insert', true);
    const append = await viewer.append('append', 1);
    expect(append).toMatchObject({ granted: true });
    await viewer.settle('append', true);
    const insert_id = insert.rowIds![0]!;
    const append_id = append.rowIds![0]!;
    const templates = [insert.formatTemplate!, append.formatTemplate!]
        .filter((template, index, all) => all.findIndex((other) => other.id === template.id) === index);
    const rows: PendingAppendedRow[] = [
        {
            id: insert_id,
            origin: 'insert',
            cells: { 0: { value: 'Grape' }, 1: { value: '4' }, 2: { value: '0.5' } },
            formatTemplateId: insert.formatTemplate!.id,
            createdOrder: 1,
        },
        {
            id: append_id,
            cells: { 0: { value: 'Kiwi' }, 1: { value: '2' } },
            formatTemplateId: append.formatTemplate!.id,
            createdOrder: 2,
        },
    ];
    const structural: Partial<WorksheetPendingEdits> = {
        formatTemplates: templates,
        appendedRows: rows,
        appendBasis: append.appendBasis!,
        rowLayout: {
            runs: [
                { kind: 'source', start: 1, count: 4 },
                { kind: 'pending', ids: [insert_id] },
                { kind: 'source', start: 5, count: 2 },
            ],
            removedSourceRows: [{ start: 2, count: 1 }],
            discardedPendingRows: [],
        },
        structuralBasis: viewer.basis(0),
    };
    return { insert, append, insert_id, append_id, structural };
}

describe('the .xlsx structural editing capability', () => {
    it('ships per-worksheet, per-axis support with the merges, AutoFilter, and rules, and a per-part basis', async () => {
        const raw = representative_workbook();
        const viewer = await open_xlsx(raw, { state: HEADER_ON });
        const [data, summary] = viewer.capability().sheets;
        expect(data).toMatchObject({
            rows: { supported: true },
            columns: { supported: true },
            merges: ['E2:F3'],
            autoFilter: { ref: 'A1:D7', filteredColumns: [] },
            relativeRules: [
                { kind: 'conditionalFormatting', sqref: 'B2:B7', formulas: ['B2>C2'] },
                { kind: 'dataValidation', sqref: 'B2:B7', formulas: ['0'] },
            ],
        });
        const zip = ZipPackage.open(raw);
        const digest = (path: string) => content_digest(zip.read(`/${path}`)!);
        expect(data!.basis).toEqual({
            kind: 'xlsx',
            worksheetPartDigest: digest('xl/worksheets/sheet1.xml'),
            sharedStringsDigest: digest('xl/sharedStrings.xml'),
            stylesDigest: digest('xl/styles.xml'),
            workbookDigest: digest('xl/workbook.xml'),
            sourceRowCount: 7,
            sourceColumnCount: 6,
        });
        expect(summary!.basis).toMatchObject({ worksheetPartDigest: digest('xl/worksheets/sheet2.xml') });
    });

    it('refuses a worksheet the scan refuses, in the menus\' words, and keeps others supported', async () => {
        const raw = build_fixture_xlsx({
            sheets: [
                { name: 'Plain', body: `<sheetData>${row(1, [cell('A1', 1)])}</sheetData>` },
                {
                    name: 'Arrays',
                    body: `<sheetData>${row(1, [cell('A1', 1), '<c r="B1"><f t="array" ref="B1">A1*2</f><v>2</v></c>'])}</sheetData>`,
                },
            ],
        });
        const viewer = await open_xlsx(raw);
        const [plain, arrays] = viewer.capability().sheets;
        expect(plain!.rows).toEqual({ supported: true });
        expect(arrays!.rows).toEqual({
            supported: false,
            reason: "Can't insert or delete rows on this sheet: cell B1 has an array formula.",
            moveReason: "Can't move rows on this sheet: cell B1 has an array formula.",
        });
        const refused = await viewer.insert({ requestId: 'refused', anchor: 0, side: 'after', sheet: 1 });
        expect(refused).toMatchObject({ granted: false });
    });
});

describe('inserted row formats', () => {
    it('copies the live source row above, or the row below when inserted directly below the Header Row', async () => {
        const viewer = await open_xlsx(representative_workbook(), { state: HEADER_ON });
        // After Date (source row 4): Date's fill and row style.
        const below_date = await viewer.insert({ requestId: 'a', anchor: 4, side: 'after' });
        expect(below_date.formatTemplate!.format).toMatchObject({
            kind: 'xlsx',
            templateSourceRow: 4,
            cellStyleIndexes: [3, 3, 2, null, null, null],
            rowStyleIndex: 3,
        });
        await viewer.settle('a', false);
        // Before Apple, the first body row: directly below the Header Row, so
        // Apple's own format, never the bold header's.
        const top = await viewer.insert({ requestId: 'b', anchor: 1, side: 'before' });
        expect(top.formatTemplate!.format).toMatchObject({
            kind: 'xlsx',
            templateSourceRow: 1,
            cellStyleIndexes: [null, null, 2, null, null, null],
        });
        expect(top.formatTemplate!.format).not.toHaveProperty('rowStyleIndex');
        await viewer.settle('b', false);
    });

    it('uses the default format on a header-only worksheet', async () => {
        const raw = build_fixture_xlsx({
            sheets: [{ name: 'Data', body: `<sheetData>${row(1, [cell('A1', 'Item', 1), cell('B1', 'Qty', 1)])}</sheetData>` }],
        });
        const viewer = await open_xlsx(raw, { state: HEADER_ON });
        const reply = await viewer.insert({ requestId: 'h', anchor: 0, side: 'after' });
        // Inserting below the Header Row of a header-only sheet is refused by
        // the anchor rule (rows can't go above or at the header), so a
        // header-only body takes the default through append instead.
        expect(reply.granted).toBe(false);
        const appended = await viewer.append('h-append', 1);
        expect(appended.formatTemplate!.format).toMatchObject({ kind: 'xlsx', templateSourceRow: null });
    });
});

describe('saving .xlsx row changes', () => {
    it('saves a delete, an insert, an append, and a cell edit together', async () => {
        const raw = representative_workbook({ calcChain: true });
        const viewer = await open_xlsx(raw, { state: { ...HEADER_ON, rowHeights: [{ 2: 30, 3: 31, 5: 33 }] } });
        const { insert_id, append_id, structural } = await delete_insert_append(viewer);
        const result = await viewer.save([{
            sheetIndex: 0,
            structural,
            cells: { '3:1': { value: '70', base: '7' } },
        }]);
        expect(result.rejection).toBeUndefined();
        expect(result).toMatchObject({ success: true });
        expect(result.receipt).toMatchObject({
            appendedRows: [{ sheetIndex: 0, sheetName: 'Data', pendingRowId: append_id, sourceRow: 7 }],
            removedSourceRows: [],
            structure: [{
                sheetIndex: 0,
                sheetName: 'Data',
                rowRuns: [{ from: 1, count: 1, to: 1 }, { from: 3, count: 2, to: 2 }, { from: 5, count: 2, to: 5 }],
                removedRows: [{ start: 2, count: 1 }],
                columnMap: [0, 1, 2, 3, 4, 5],
                insertedRows: [{ pendingRowId: insert_id, sourceRow: 4 }],
                insertedColumns: [],
            }],
        });
        const saved = viewer.file.bytes;
        const data = part_text(saved, 'xl/worksheets/sheet1.xml')!;
        const summary = part_text(saved, 'xl/worksheets/sheet2.xml')!;
        if (process.env.DUMP_XLSX) { console.log(data); console.log(summary); console.log(part_text(saved, 'xl/workbook.xml')); require('node:fs').writeFileSync(process.env.DUMP_XLSX, saved); }
        const rows = rows_of(data);
        expect([...rows.keys()]).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
        // Cherry moved up a row, with its edit; Grape copies Date's format.
        expect(rows.get(3)!.inner).toContain('<c r="B3"><v>70</v></c>');
        expect(rows.get(5)!.open).toContain('s="3"');
        expect(rows.get(5)!.open).toContain('customFormat="1"');
        expect(rows.get(5)!.inner).toMatch(/<c r="A5" s="3"[^>]*>.*Grape/);
        // The shared Total formula renders per row; every cache is invalidated.
        for (const number of [2, 3, 4, 6, 7]) {
            expect(data).toMatch(new RegExp(`<c r="D${number}"><f[^>]*>B${number}\\*C${number}</f></c>|<c r="D${number}"><f[^>]*>[^<]*</f></c>`));
        }
        expect(data).toContain('<mergeCell ref="E2:F2"/>');
        expect(data).toContain('sqref="B2:B7"');
        expect(data).toContain('<autoFilter ref="A1:D7"/>');
        expect(data).toContain('<hyperlink ref="A3" location="Summary!A1" display="Summary"/>');
        expect(data).not.toContain('r:id="rId1"');
        expect(part_text(saved, 'xl/worksheets/_rels/sheet1.xml.rels')).not.toContain('example.com');
        expect(part_text(saved, 'xl/worksheets/_rels/sheet1.xml.rels')).toContain('printerSettings');
        expect(data).toContain('activeCell="B3"');
        // Other worksheets' formulas follow; their caches are invalidated.
        expect(summary).toContain('<f>SUM(Data!D2:D7)</f>');
        expect(summary).toContain('<f>Data!B4</f>');
        expect(summary).toContain('<f>Data!$C$7</f>');
        expect(summary).not.toMatch(/<v>/);
        expect(part_text(saved, 'xl/workbook.xml')).toContain('<definedName name="Quantities">Data!$B$2:$B$7</definedName>');
        expect(ZipPackage.open(saved).has('/xl/calcChain.xml')).toBe(false);
        expect(part_text(saved, '[Content_Types].xml')).not.toContain('calcChain');

        const parsed = await parse_xlsx(saved);
        const [data_sheet] = parsed.data.sheets;
        expect(cell_values(data_sheet!.rows as unknown[][]).map((cells) => cells.slice(0, 3))).toEqual([
            ['Item', 'Qty', 'Price'],
            ['Apple', 3, 0.5],
            ['Cherry', 70, 2],
            ['Date', 9, 1.5],
            ['Grape', 4, 0.5],
            ['Elder', 11, 3],
            ['Fig', 13, 0.75],
            ['Kiwi', 2, null],
        ]);

        // The rekey: Banana's height is dropped, Cherry's moves up, Elder's stays.
        await vi.waitFor(() => expect(viewer.durable().pendingEdits).toBeUndefined());
        expect(viewer.durable().rowHeights?.[0]).toEqual({ 2: 31, 5: 33 });
        expect(viewer.durable().structuralRekeyIntent).toBeUndefined();
    });
});
