// `.xlsx` structural editing through the controller (row and column
// structure design, delivery step 9c): the capability the snapshot ships,
// insert admission with an anchor-row format template, and saves that delete,
// insert, append, and edit in combination, checked against the written
// package, the receipt, the rekey, and `parse_xlsx`.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { profile_for, simulate_process_restart_for_tests } from '../viewer-controller';
import { current_structural_basis } from '../structural-editing-capability';
import { observe_xlsx_structure } from '../xlsx-structural-observation';
import type { PerFileState, WorksheetPendingEdits } from '../types';
import { EMPTY_PENDING_STRUCTURAL_CHANGES, type PendingAppendedRow } from '../pending-changes';
import {
    merge_destination_message,
    MERGE_SPLIT_MESSAGE,
    type WorksheetStructureContext,
} from '../webview/pending-row-store';
import {
    merge_ranges_of,
    plan_row_move,
    row_move_block_refusal,
    row_move_item_model,
    type RowStructureSelection,
} from '../webview/row-structure-model';
import { content_digest } from '../content-digest';
import { parse_xlsx } from '../parse-xlsx';
import { ZipPackage } from '../zip-package';
import { build_fixture_xlsx, cell, representative_workbook, row } from './helpers/xlsx-structure-fixture';
import { FILE, open_xlsx, part_text, with_parts, type OpenXlsx } from './helpers/xlsx-viewer';
import * as vscode_mock from './mocks/vscode';
import { history_value, value_only_overlay } from '../webview/history-cell-state-model';
import { wire_overlay_from_cell_overlay_state } from '../webview/history-replay-wire-model';

afterEach(() => {
    for (const panel of vscode_mock.__getPanels()) panel.dispose();
    vi.restoreAllMocks();
    vscode_mock.__reset();
    simulate_process_restart_for_tests();
});

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
            bodyStart: 1,
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
        const rows = rows_of(data);
        expect([...rows.keys()]).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
        // Cherry moved up a row, with its edit; Grape copies Date's format.
        expect(rows.get(3)!.inner).toContain('<c r="B3"><v>70</v></c>');
        expect(rows.get(5)!.open).toContain('s="3"');
        expect(rows.get(5)!.open).toContain('customFormat="1"');
        expect(rows.get(5)!.inner).toMatch(/<c r="A5" s="3"[^>]*>.*Grape/);
        // The shared Total formula renders per row; every cache is invalidated.
        for (const number of [2, 3, 4, 6, 7]) {
            expect(data).toContain(`<c r="D${number}"><f>B${number}*C${number}</f></c>`);
        }
        expect(rows.get(5)!.inner).not.toContain('<f>');
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

/** Data's body without Banana (source row 2), as a publication or save carries it. */
function removal(viewer: OpenXlsx): Partial<WorksheetPendingEdits> {
    return {
        rowLayout: {
            runs: [{ kind: 'source', start: 1, count: 6 }],
            removedSourceRows: [{ start: 2, count: 1 }],
            discardedPendingRows: [],
        },
        structuralBasis: viewer.basis(0),
    };
}

describe('the per-part Structural Basis', () => {
    it.each([
        ['another worksheet', 'xl/worksheets/sheet2.xml', false],
        ['the worksheet', 'xl/worksheets/sheet1.xml', true],
        ['the shared strings', 'xl/sharedStrings.xml', true],
        ['the styles', 'xl/styles.xml', true],
        ['the workbook', 'xl/workbook.xml', true],
    ] as const)('conflicts when %s changes: %s', async (_label, path, conflicts) => {
        const raw = representative_workbook();
        const viewer = await open_xlsx(raw, { state: HEADER_ON });
        const changes = removal(viewer);
        expect(await viewer.publish(0, changes)).toBe(true);
        const original = part_text(raw, path)!;
        // A semantically neutral edit, so the workbook still opens the same.
        await viewer.change(with_parts(raw, { [path]: original.replace('?>', '?>\n') }));
        const slot = viewer.durable().pendingEdits?.[0];
        if (conflicts) {
            await vi.waitFor(() => expect(viewer.durable().pendingEdits?.[0]?.conflicts)
                .toEqual([{ reason: 'structuralBasisChanged', pendingRowIds: [], tailRemovalIds: [] }]));
            const result = await viewer.save([{ sheetIndex: 0, structural: { ...changes, conflicts: viewer.durable().pendingEdits![0]!.conflicts } }]);
            expect(result).toMatchObject({
                success: false,
                rejection: { reason: 'structuralConflict', structuralReason: 'structuralBasisChanged' },
            });
            expect(viewer.file.writes).toHaveLength(0);
        } else {
            expect(slot?.conflicts ?? []).toEqual([]);
            expect(viewer.basis(0)).toEqual(changes.structuralBasis);
            const result = await viewer.save([{ sheetIndex: 0, structural: changes }]);
            expect(result).toMatchObject({ success: true });
            expect(rows_of(part_text(viewer.file.bytes, 'xl/worksheets/sheet1.xml')!).size).toBe(6);
            // The rendering reads the current file: the other sheet's change is kept.
            expect(part_text(viewer.file.bytes, 'xl/worksheets/sheet2.xml')!.startsWith(original.replace('?>', '?>\n').slice(0, 60))).toBe(true);
        }
    });
});

describe('the worksheet row ceiling', () => {
    it('publishes an insert that replaces a deleted row on a sheet at the ceiling', async () => {
        // Seven rows (the Header Row and six body rows) on a seven-row sheet.
        const viewer = await open_xlsx(representative_workbook(), {
            state: HEADER_ON,
            profile: { ...profile_for(FILE), append_row_ceiling: 7 },
        });
        const changes = removal(viewer);
        expect(await viewer.publish(0, changes)).toBe(true);
        // Admission counts the live layout rows, so the deleted row makes room.
        const insert = await viewer.insert({ requestId: 'insert', anchor: 4, side: 'after' });
        expect(insert).toMatchObject({ granted: true });
        await viewer.settle('insert', true);
        const insert_id = insert.rowIds![0]!;
        // Publication counts them the same way.
        expect(await viewer.publish(0, {
            ...changes,
            formatTemplates: [insert.formatTemplate!],
            appendedRows: [{
                id: insert_id,
                origin: 'insert',
                cells: { 0: { value: 'Grape' } },
                formatTemplateId: insert.formatTemplate!.id,
                createdOrder: 1,
            }],
            appendBasis: insert.appendBasis!,
            rowLayout: {
                runs: [
                    { kind: 'source', start: 1, count: 4 },
                    { kind: 'pending', ids: [insert_id] },
                    { kind: 'source', start: 5, count: 2 },
                ],
                removedSourceRows: [{ start: 2, count: 1 }],
                discardedPendingRows: [],
            },
        })).toBe(true);
        expect(viewer.durable().pendingEdits?.[0]?.appendedRows?.map((row) => row.id)).toEqual([insert_id]);
        // A second insert would exceed it.
        expect(await viewer.insert({ requestId: 'over', anchor: 4, side: 'after' })).toMatchObject({ granted: false });
    });
});

describe('structural save refusals', () => {
    async function refused_save(viewer: OpenXlsx, structural: Partial<WorksheetPendingEdits>) {
        const result = await viewer.save([{ sheetIndex: 0, structural }]);
        expect(result).toMatchObject({
            success: false,
            rejection: { reason: 'structuralConflict', structuralReason: 'unsupportedStructure', worksheetOperationIndex: 0 },
        });
        expect(viewer.file.writes).toHaveLength(0);
        return (result.rejection as { message: string }).message;
    }

    it('re-runs the support scan on the bytes it rewrites, and records the refusal for Review Changes', async () => {
        const raw = representative_workbook();
        const viewer = await open_xlsx(raw, { state: HEADER_ON });
        const changes = removal(viewer);
        expect(await viewer.publish(0, changes)).toBe(true);
        // A table related to Data through its relationships part only: the
        // Structural Basis (worksheet, strings, styles, workbook) still
        // matches, but the sheet is no longer supported.
        const rels = part_text(raw, 'xl/worksheets/_rels/sheet1.xml.rels')!.replace(
            '</Relationships>',
            '<Relationship Id="rId9" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/table" Target="../tables/table1.xml"/></Relationships>',
        );
        await viewer.change(with_parts(raw, {
            'xl/worksheets/_rels/sheet1.xml.rels': rels,
            'xl/tables/table1.xml': '<table xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" id="1" name="T" displayName="T" ref="A1:D7"/>',
        }));
        expect(viewer.durable().pendingEdits?.[0]?.conflicts ?? []).toEqual([]);
        expect(viewer.capability().sheets[0]!.rows.supported).toBe(false);
        const message = await refused_save(viewer, changes);
        expect(message).toMatch(/^Can't insert, delete, or move rows on this sheet: /);
        // Recorded on the worksheet's slot, so the webview's echo of it is
        // accepted, and a later save re-derives it rather than being blocked.
        const conflict = { reason: 'unsupportedStructure' as const, pendingRowIds: [], tailRemovalIds: [], message };
        expect(viewer.durable().pendingEdits?.[0]?.conflicts).toEqual([conflict]);
        expect(await viewer.publish(0, { ...changes, conflicts: [conflict] })).toBe(true);
        expect(await refused_save(viewer, { ...changes, conflicts: [conflict] })).toBe(message);
        // Discarding the layout answers it.
        expect(await viewer.publish(0, { conflicts: [] })).toBe(true);
        expect(viewer.durable().pendingEdits?.[0]?.conflicts ?? []).toEqual([]);
    });

    it('keeps the refusal when an unrelated cell edit is undone', async () => {
        const raw = representative_workbook();
        const viewer = await open_xlsx(raw, {
            state: { ...HEADER_ON, pendingEdits: [{ sheetName: 'Data', cells: { '3:1': { value: '70', base: '7' } } }] },
        });
        expect(viewer.durable().pendingEdits?.[0]?.cells).toEqual({ '3:1': { value: '70', base: '7' } });
        const changes = removal(viewer);
        expect(await viewer.publish(0, { ...changes, cells: { '3:1': { value: '70', base: '7' } } })).toBe(true);
        expect(viewer.durable().pendingEdits?.[0]?.cells).toEqual({ '3:1': { value: '70', base: '7' } });
        const rels = part_text(raw, 'xl/worksheets/_rels/sheet1.xml.rels')!.replace(
            '</Relationships>',
            '<Relationship Id="rId9" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/table" Target="../tables/table1.xml"/></Relationships>',
        );
        await viewer.change(with_parts(raw, {
            'xl/worksheets/_rels/sheet1.xml.rels': rels,
            'xl/tables/table1.xml': '<table xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" id="1" name="T" displayName="T" ref="A1:D7"/>',
        }));
        const result = await viewer.save([{ sheetIndex: 0, structural: changes, cells: { '3:1': { value: '70', base: '7' } } }]);
        expect(result).toMatchObject({ success: false, rejection: { structuralReason: 'unsupportedStructure' } });
        const message = (result.rejection as { message: string }).message;
        expect(viewer.durable().pendingEdits?.[0]?.cells).toEqual({ '3:1': { value: '70', base: '7' } });
        const conflict = { reason: 'unsupportedStructure' as const, pendingRowIds: [], tailRemovalIds: [], message };
        expect(viewer.durable().pendingEdits?.[0]?.conflicts).toEqual([conflict]);
        // Undo the cell edit; the removal is still pending, so its refusal stays.
        const committed = await viewer.replay('undo-cell', [{
            ordinal: 0,
            worksheet: { sheetIndex: 0, sheetName: 'Data' },
            sourceRow: 3,
            sourceColumn: 1,
            overlay: wire_overlay_from_cell_overlay_state(value_only_overlay(history_value('70'), history_value('7'))),
        }]);
        expect(committed).toBeDefined();
        expect(viewer.durable().pendingEdits?.[0]?.cells ?? {}).toEqual({});
        expect(viewer.durable().pendingEdits?.[0]?.conflicts).toEqual([conflict]);
        // No host-derived conflict transition tells the renderer to drop it.
        expect((committed as { committed: { structures?: unknown[] } }).committed.structures ?? []).toEqual([]);
    });

    it('keeps a basis change when an unrelated cell edit is undone', async () => {
        const raw = representative_workbook();
        const viewer = await open_xlsx(raw, {
            state: { ...HEADER_ON, pendingEdits: [{ sheetName: 'Data', cells: { '3:1': { value: '70', base: '7' } } }] },
        });
        expect(await viewer.publish(0, { ...removal(viewer), cells: { '3:1': { value: '70', base: '7' } } })).toBe(true);
        // Another tool rewrites Data's part, with a cell the layout does not touch.
        const sheet = part_text(raw, 'xl/worksheets/sheet1.xml')!;
        await viewer.change(with_parts(raw, { 'xl/worksheets/sheet1.xml': sheet.replace('?>', '?>\n') }));
        const conflict = { reason: 'structuralBasisChanged' as const, pendingRowIds: [], tailRemovalIds: [] };
        await vi.waitFor(() => expect(viewer.durable().pendingEdits?.[0]?.conflicts).toEqual([conflict]));
        const committed = await viewer.replay('undo-cell', [{
            ordinal: 0,
            worksheet: { sheetIndex: 0, sheetName: 'Data' },
            sourceRow: 3,
            sourceColumn: 1,
            overlay: wire_overlay_from_cell_overlay_state(value_only_overlay(history_value('70'), history_value('7'))),
        }]);
        expect(committed).toBeDefined();
        expect(viewer.durable().pendingEdits?.[0]?.cells ?? {}).toEqual({});
        expect(viewer.durable().pendingEdits?.[0]?.conflicts).toEqual([conflict]);
        expect((committed as { committed: { structures?: unknown[] } }).committed.structures ?? []).toEqual([]);
    });

    it('refuses a formula on another worksheet that cannot be adjusted, naming it', async () => {
        const raw = build_fixture_xlsx({
            sheets: [
                { name: 'Data', body: `<sheetData>${[1, 2, 3, 4].map((n) => row(n, [cell(`A${n}`, n)])).join('')}</sheetData>` },
                { name: 'Other', body: `<sheetData>${row(1, [cell('A1', { f: 'SUM(Data!A1#)' })])}</sheetData>` },
            ],
        });
        const viewer = await open_xlsx(raw);
        expect(viewer.capability().sheets[0]!.rows.supported).toBe(false);
        const message = await refused_save(viewer, {
            rowLayout: { runs: [{ kind: 'source', start: 0, count: 4 }], removedSourceRows: [{ start: 1, count: 1 }], discardedPendingRows: [] },
            structuralBasis: viewer.basis(0),
        });
        expect(message).toMatch(/^Can't insert, delete, or move rows on this sheet: .*Other!A1/);
    });

    it('refuses a rule that would split into more than 64 rules', async () => {
        const body_rows = Array.from({ length: 200 }, (_, index) => row(index + 2, [cell(`A${index + 2}`, index)]));
        const raw = build_fixture_xlsx({
            sheets: [
                {
                    name: 'Data',
                    body: `<sheetData>${row(1, [cell('A1', 'n')])}${body_rows.join('')}</sheetData>`
                        + '<conditionalFormatting sqref="A2:A201"><cfRule type="expression" dxfId="0" priority="1"><formula>Other!$B2&gt;0</formula></cfRule></conditionalFormatting>',
                },
                { name: 'Other', body: `<sheetData>${row(1, [cell('B1', 1)])}</sheetData>` },
            ],
        });
        const viewer = await open_xlsx(raw);
        const removed = Array.from({ length: 70 }, (_, index) => ({ start: 2 + index * 2, count: 1 }));
        const message = await refused_save(viewer, {
            rowLayout: { runs: [{ kind: 'source', start: 0, count: 201 }], removedSourceRows: removed, discardedPendingRows: [] },
            structuralBasis: viewer.basis(0),
        });
        expect(message).toBe("Can't save these row and column changes: they would split the conditional formatting on Data!A2:A131 into more than 64 rules.");
    });

    it('refuses a moved run that would leave a merge non-rectangular', async () => {
        const viewer = await open_xlsx(representative_workbook(), { state: HEADER_ON });
        // Banana (source row 2, inside the merge E2:F3) moved below Date.
        const message = await refused_save(viewer, {
            rowLayout: {
                runs: [
                    { kind: 'source', start: 1, count: 1 },
                    { kind: 'source', start: 3, count: 2 },
                    { kind: 'source', start: 2, count: 1 },
                    { kind: 'source', start: 5, count: 2 },
                ],
                removedSourceRows: [],
                discardedPendingRows: [],
            },
            structuralBasis: viewer.basis(0),
        });
        expect(message).toContain('merged cell E2:F3');
    });
});

describe('moved rows', () => {
    it('writes a layout with moved runs, carrying cells, formulas, and attachments with their rows', async () => {
        const viewer = await open_xlsx(representative_workbook(), { state: HEADER_ON });
        // Fig (source row 6) moved to the top of the body; Cherry and Date swapped.
        const result = await viewer.save([{
            sheetIndex: 0,
            structural: {
                rowLayout: {
                    runs: [
                        { kind: 'source', start: 6, count: 1 },
                        { kind: 'source', start: 1, count: 2 },
                        { kind: 'source', start: 4, count: 1 },
                        { kind: 'source', start: 3, count: 1 },
                        { kind: 'source', start: 5, count: 1 },
                    ],
                    removedSourceRows: [],
                    discardedPendingRows: [],
                },
                structuralBasis: viewer.basis(0),
            },
        }]);
        expect(result.rejection).toBeUndefined();
        expect(result).toMatchObject({
            success: true,
            receipt: { structure: [{ rowRuns: [
                { from: 1, count: 2, to: 2 },
                { from: 3, count: 1, to: 5 },
                { from: 4, count: 1, to: 4 },
                { from: 5, count: 1, to: 6 },
                { from: 6, count: 1, to: 1 },
            ] }] },
        });
        const saved = viewer.file.bytes;
        const data = part_text(saved, 'xl/worksheets/sheet1.xml')!;
        for (const number of [2, 3, 4, 5, 6, 7]) {
            expect(data).toContain(`<f>B${number}*C${number}</f>`);
        }
        // Each row keeps its own attributes: Date (now between Banana and
        // Cherry, row 5) keeps its row style, and Cherry (row 6) has none.
        expect(rows_of(data).get(5)!.open).toContain('customFormat="1"');
        expect(rows_of(data).get(5)!.inner).toContain('Date');
        expect(rows_of(data).get(6)!.open).not.toContain('customFormat');
        expect(data).toContain('<mergeCell ref="E3:F4"/>');
        expect(data).toContain('<hyperlink ref="A4" r:id="rId1"/>');
        expect(data).toContain('<hyperlink ref="A6" location="Summary!A1" display="Summary"/>');
        const summary = part_text(saved, 'xl/worksheets/sheet2.xml')!;
        expect(summary).toContain('<f>Data!B5</f>');
        expect(summary).toContain('<f>Data!$C$2</f>');
        const parsed = await parse_xlsx(saved);
        expect(cell_values(parsed.data.sheets[0]!.rows as unknown[][]).map((cells) => cells[0])).toEqual([
            'Item', 'Fig', 'Apple', 'Banana', 'Date', 'Cherry', 'Elder',
        ]);
    });
});

describe('an interrupted .xlsx structural save', () => {
    it('applies the stored rekey intent on the next load after a stop between write and post-write', async () => {
        const raw = representative_workbook();
        const first = await open_xlsx(raw, { state: { ...HEADER_ON, rowHeights: [{ 3: 31 }] } });
        const changes = removal(first);
        first.file.write = (content) => {
            first.file.bytes = content;
            first.file.mtime += 1;
            return new Promise<never>(() => {});
        };
        void first.save([{ sheetIndex: 0, structural: changes }]);
        await vi.waitFor(() => expect(first.file.writes).toHaveLength(1));
        expect(first.store.get_state(FILE).structuralRekeyIntent).toBeDefined();
        first.dispose();
        simulate_process_restart_for_tests();
        first.file.write = undefined;
        const second = await open_xlsx(first.file.bytes, { store: first.store, disk: first.file });
        const durable = second.durable();
        expect(durable.structuralRekeyIntent).toBeUndefined();
        expect(durable.pendingEdits).toBeUndefined();
        expect(durable.rowHeights?.[0]).toEqual({ 2: 31 });
    });
});

describe('Pending Columns at the writer', () => {
    // No UI admits a Pending Column before delivery step 8, so this drives
    // the `.xlsx` planner directly with a layout built in the test.
    it('writes a source-format column beside its neighbor and a default one, with headers and cells', async () => {
        const raw = representative_workbook();
        const path = '/tmp/pending-columns.xlsx';
        const profile = profile_for(path);
        const source = await profile.build_source(raw, path, HEADER_ON);
        const sheet = source.meta().sheets[0]!;
        const basis = current_structural_basis(
            'xlsx',
            { digest: content_digest(raw), xlsxStructure: observe_xlsx_structure(raw) },
            sheet,
            0,
        )!;
        const plan = profile.plan_save!({
            source,
            file_path: path,
            worksheets: [{
                sheet_index: 0,
                edits: {},
                wanted_bases: new Set(),
                dirty_edits: {},
                structural_changes: {
                    formatTemplates: [],
                    appendedRows: [],
                    tailRemovals: [],
                    conflicts: [],
                    columnLayout: {
                        columns: [
                            { kind: 'source', sourceColumn: 0 },
                            { kind: 'source', sourceColumn: 1 },
                            { kind: 'source', sourceColumn: 2 },
                            { kind: 'pending', pendingColumnId: 'col-a' },
                            { kind: 'source', sourceColumn: 3 },
                            { kind: 'source', sourceColumn: 4 },
                            { kind: 'source', sourceColumn: 5 },
                            { kind: 'pending', pendingColumnId: 'col-b' },
                        ],
                        removedSourceColumns: [],
                        discardedPendingColumns: [],
                    },
                    pendingColumns: [
                        {
                            id: 'col-a',
                            header: 'Discount',
                            cells: { 's:2': { value: '0.1' }, 's:3': { value: '=C4*2' } },
                            format: { kind: 'source', sourceColumn: 2 },
                            createdOrder: 1,
                        },
                        {
                            id: 'col-b',
                            header: 'Note',
                            cells: { 's:1': { value: 'first' } },
                            format: { kind: 'default' },
                            createdOrder: 2,
                        },
                    ],
                    structuralBasis: basis,
                },
            }],
        });
        expect(plan.receipt?.structure?.[0]).toMatchObject({
            columnMap: [0, 1, 2, 4, 5, 6],
            insertedColumns: [{ pendingColumnId: 'col-a', column: 3 }, { pendingColumnId: 'col-b', column: 7 }],
        });
        const saved = plan.produce(raw);
        source.close();
        const data = part_text(saved, 'xl/worksheets/sheet1.xml')!;
        const rows = rows_of(data);
        // Headers, each row copying the inherited column's style (bold in the
        // Header Row, percent below) in the new
        // column D; the default column H writes no style.
        expect(rows.get(1)!.inner).toContain('<c r="D1" s="1" t="inlineStr"><is><t xml:space="preserve">Discount</t></is></c>');
        expect(rows.get(1)!.inner).toContain('Note');
        expect(rows.get(3)!.inner).toContain('<c r="D3" s="2"><v>0.1</v></c>');
        expect(rows.get(4)!.inner).toMatch(/<c r="D4" s="2"><f>C4\*2<\/f><\/c>/);
        expect(rows.get(2)!.inner).toMatch(/<c r="H2"[^>]*>.*first/);
        expect(rows.get(2)!.inner).not.toMatch(/<c r="H2" s=/);
        // Old D (Total) is now E. Its shared group shifted as a whole, so it
        // stays shared with its master's ref re-rendered; the widths shift.
        expect(data).toContain('<c r="E2"><f t="shared" si="0" ref="E2:E7">B2*C2</f></c>');
        expect(data).toContain('<mergeCell ref="F2:G3"/>');
        expect(data).toContain('<col min="3" max="4" width="10" style="2" customWidth="1"/>');
        expect(data).toContain('<autoFilter ref="A1:E7"/>');
        expect(part_text(saved, 'xl/worksheets/sheet2.xml')).toContain('<f>SUM(Data!E2:E7)</f>');
    });
});

describe('row moves through the step 7 model on .xlsx', () => {
    it('refuses moves across a shipped merge, and saves a move that round-trips through parse_xlsx', async () => {
        const viewer = await open_xlsx(representative_workbook(), { state: HEADER_ON });
        const support = viewer.capability().sheets[0]!;
        const context: WorksheetStructureContext = {
            worksheet: { sheetIndex: 0, sheetName: 'Data', worksheetId: '1' },
            bodyStart: 1,
            sourceRowCount: 7,
            sourceColumnCount: 6,
            bodyViewTransformed: false,
            // As GridShell builds it: the merges the host's support scan shipped.
            merges: merge_ranges_of(support.merges!),
            structuralBasis: support.basis!,
        };
        const selection = (rows: readonly number[]): RowStructureSelection => ({
            count: rows.length,
            identities: rows.map((sourceRow) => ({ kind: 'source', sourceRow })),
            removedSourceRows: [],
            fixedRows: false,
            tailRemovals: false,
            contiguous: true,
            bandRows: 0,
            endsAtBandEnd: false,
        });
        const input = (rows: readonly number[]) => ({
            support: support.rows,
            ready: true,
            selection: selection(rows),
            changes: EMPTY_PENDING_STRUCTURAL_CHANGES,
            context,
        });
        // An axis the scan refuses gives Move its own wording.
        expect(row_move_block_refusal({
            ...input([3]),
            support: { supported: false, reason: "Can't insert or delete rows on this sheet: x.", moveReason: "Can't move rows on this sheet: x." },
        })).toBe("Can't move rows on this sheet: x.");
        // Banana (source row 2) is half of the merge E2:F3: no Move item, and
        // no drag, whatever the destination.
        expect(row_move_block_refusal(input([2]))).toBe(MERGE_SPLIT_MESSAGE);
        expect(row_move_item_model(input([2]), 'forward')).toMatchObject({ enabled: false, reason: MERGE_SPLIT_MESSAGE });
        // Cherry one step up would land between Apple and Banana, inside the merge.
        expect(row_move_item_model(input([3]), 'backward'))
            .toMatchObject({ enabled: false, reason: merge_destination_message('rows') });
        expect(plan_row_move(EMPTY_PENDING_STRUCTURAL_CHANGES, context, [{ kind: 'source', sourceRow: 3 }], { kind: 'source', sourceRow: 2 }))
            .toMatchObject({ ok: false, message: merge_destination_message('rows') });
        // The whole merge moves together: Apple and Banana below Elder.
        const plan = plan_row_move(
            EMPTY_PENDING_STRUCTURAL_CHANGES,
            context,
            [{ kind: 'source', sourceRow: 1 }, { kind: 'source', sourceRow: 2 }],
            { kind: 'source', sourceRow: 6 },
        );
        if (!plan.ok) throw new Error(plan.message);
        const result = await viewer.save([{
            sheetIndex: 0,
            structural: { rowLayout: plan.outcome.next.rowLayout!, structuralBasis: support.basis! },
        }]);
        expect(result.rejection).toBeUndefined();
        expect(result).toMatchObject({ success: true });
        const saved = viewer.file.bytes;
        expect(part_text(saved, 'xl/worksheets/sheet1.xml')).toContain('<mergeCell ref="E5:F6"/>');
        const parsed = await parse_xlsx(saved);
        expect(cell_values(parsed.data.sheets[0]!.rows as unknown[][]).map((cells) => cells.slice(0, 2))).toEqual([
            ['Item', 'Qty'], ['Cherry', 7], ['Date', 9], ['Elder', 11], ['Apple', 3], ['Banana', 5], ['Fig', 13],
        ]);
        expect(part_text(saved, 'xl/worksheets/sheet2.xml')).toContain('<f>Data!B3</f>');
    });
});

/** Plan an `.xlsx` save directly through the profile's planner, with the file's current basis. */
async function plan_directly(
    raw: Uint8Array,
    state: PerFileState,
    structural: Partial<WorksheetPendingEdits>,
    edits: Record<string, string> = {},
) {
    const path = '/tmp/plan-directly.xlsx';
    const profile = profile_for(path);
    const source = await profile.build_source(raw, path, state);
    const basis = current_structural_basis(
        'xlsx',
        { digest: content_digest(raw), xlsxStructure: observe_xlsx_structure(raw) },
        source.meta().sheets[0]!,
        0,
    )!;
    try {
        return profile.plan_save!({
            source,
            file_path: path,
            worksheets: [{
                sheet_index: 0,
                edits,
                wanted_bases: new Set(),
                dirty_edits: Object.fromEntries(Object.entries(edits).map(([key, value]) => [key, { value, base: '' }])),
                structural_changes: {
                    formatTemplates: [],
                    appendedRows: [],
                    tailRemovals: [],
                    conflicts: [],
                    structuralBasis: basis,
                    ...structural,
                },
            }],
        });
    } finally {
        source.close();
    }
}

describe('column names in a structural save', () => {
    // Data's header: Item, Qty, Price, Total, and two unnamed columns. Price
    // (source column 2) is deleted in each case.
    const without_price = (pending: readonly { id: string; header: string }[] = []): Partial<WorksheetPendingEdits> => ({
        columnLayout: {
            columns: [
                ...[0, 1, 2, 3, 4, 5].map((sourceColumn) => ({ kind: 'source' as const, sourceColumn })),
                ...pending.map(({ id }) => ({ kind: 'pending' as const, pendingColumnId: id })),
            ],
            removedSourceColumns: [2],
            discardedPendingColumns: [],
        },
        ...(pending.length === 0 ? {} : {
            pendingColumns: pending.map(({ id, header }, index) => ({
                id, header, cells: {}, format: { kind: 'default' as const }, createdOrder: index + 1,
            })),
        }),
    });

    it('checks a rename only against the live prospective columns, Pending Columns included', async () => {
        const raw = representative_workbook();
        await expect(plan_directly(raw, HEADER_ON, without_price(), { '0:1': 'Amount' })).resolves.toBeDefined();
        await expect(plan_directly(raw, HEADER_ON, without_price(), { '0:1': 'Total' }))
            .rejects.toThrow('Another column already has that name.');
        await expect(plan_directly(raw, HEADER_ON, without_price([{ id: 'new', header: 'Amount' }]), { '0:1': 'amount' }))
            .rejects.toThrow('Another column already has that name.');
    });

    it('refuses a deleted column\'s name with its own reason, since references to it would rebind', async () => {
        await expect(plan_directly(representative_workbook(), HEADER_ON, without_price(), { '0:1': 'Price' }))
            .rejects.toThrow('A deleted column on this sheet is named Price. Restore it or choose another name.');
    });
});

describe('the workbook formula limit in a structural save', () => {
    // 100,000 formulas, the limit: B1, then A2:A100000. Moving row 1 to the
    // end puts the old B1 formula at B100000 and a value cell at B1.
    function at_the_limit(): Uint8Array {
        const rows = [row(1, [cell('A1', 'v'), cell('B1', { f: '1' })])];
        for (let number = 2; number <= 100_000; number += 1) rows.push(row(number, [cell(`A${number}`, { f: '1' })]));
        return build_fixture_xlsx({ sheets: [{ name: 'Data', body: `<sheetData>${rows.join('')}</sheetData>` }] });
    }
    const moved_first_row_to_end: Partial<WorksheetPendingEdits> = {
        rowLayout: {
            runs: [{ kind: 'source', start: 1, count: 99_999 }, { kind: 'source', start: 0, count: 1 }],
            removedSourceRows: [],
            discardedPendingRows: [],
        },
    };

    it('counts moved formulas where they land, so a new formula past the limit is refused', async () => {
        const raw = at_the_limit();
        // B2 (source row 1) lands on B1, the old formula's source address,
        // which must not count as overwriting it: that formula moved to B100000.
        await expect(plan_directly(raw, {}, moved_first_row_to_end, { '1:1': '=2' }))
            .rejects.toThrow('Workbook would contain too many formulas to save safely.');
        // A value there, or a formula over one that moved there, keeps the count.
        await expect(plan_directly(raw, {}, moved_first_row_to_end, { '1:1': '2' })).resolves.toBeDefined();
        await expect(plan_directly(raw, {}, moved_first_row_to_end, { '0:1': '=2' })).resolves.toBeDefined();
    }, 60_000);
});

describe('publishing inserted .xlsx rows', () => {
    it('accepts a row whose template copies a row styled unlike the append template', async () => {
        const viewer = await open_xlsx(representative_workbook(), { state: HEADER_ON });
        // After Date: its fill and row style, unlike Fig, the append template's row.
        const insert = await viewer.insert({ requestId: 'styled', anchor: 4, side: 'after' });
        await viewer.settle('styled', true);
        const id = insert.rowIds![0]!;
        expect(insert.formatTemplate!.format.kind === 'xlsx' && insert.formatTemplate!.format.styleFingerprint)
            .not.toBe(insert.appendBasis!.styleFingerprint);
        expect(await viewer.publish(0, {
            formatTemplates: [insert.formatTemplate!],
            appendedRows: [{ id, origin: 'insert', cells: {}, formatTemplateId: insert.formatTemplate!.id, createdOrder: 1 }],
            appendBasis: insert.appendBasis!,
            rowLayout: {
                runs: [{ kind: 'source', start: 1, count: 4 }, { kind: 'pending', ids: [id] }, { kind: 'source', start: 5, count: 2 }],
                removedSourceRows: [],
                discardedPendingRows: [],
            },
            structuralBasis: viewer.basis(0),
        })).toBe(true);
    });
});

describe('styled text and plain values in a structural save', () => {
    it('writes styled text that starts with = as text, never rendered as a formula', async () => {
        const viewer = await open_xlsx(representative_workbook(), { state: HEADER_ON });
        // Fig's name (A7, row 6 after Banana is removed) as bold text that
        // reads like a spill reference no layout can adjust: the writer
        // stores runs as literal text, so the save must neither render nor
        // refuse it.
        const runs = [{ text: '=SUM(A2#)', style: { bold: true } }];
        const result = await viewer.save([{
            sheetIndex: 0,
            structural: removal(viewer),
            cells: { '6:0': { value: '=SUM(A2#)', base: 'Fig', valueRuns: { runs } } as never },
        }]);
        expect(result.rejection).toBeUndefined();
        expect(result).toMatchObject({ success: true });
        const a6 = /<c r="A6"[^>]*>(.*?)<\/c>/.exec(part_text(viewer.file.bytes, 'xl/worksheets/sheet1.xml')!)![1]!;
        expect(a6).not.toContain('<f>');
        expect(a6).toContain('=SUM(A2#)');
    });

    it('accepts more than 100,000 plain-value edits, as a save without a layout change does', async () => {
        const rows = Array.from({ length: 100_002 }, (_, index) => row(index + 1, [cell(`A${index + 1}`, index)]));
        const raw = build_fixture_xlsx({ sheets: [{ name: 'Data', body: `<sheetData>${rows.join('')}</sheetData>` }] });
        const edits = Object.fromEntries(Array.from({ length: 100_002 }, (_, index) => [`${index}:0`, 'x']));
        await expect(plan_directly(raw, {}, {
            rowLayout: {
                runs: [{ kind: 'source', start: 100_001, count: 1 }, { kind: 'source', start: 0, count: 100_001 }],
                removedSourceRows: [],
                discardedPendingRows: [],
            },
        }, edits)).resolves.toBeDefined();
    }, 60_000);
});
