// Row structure on an `.xlsx` worksheet whose Header Row is auto-detected
// rather than set by an override. The snapshot then carries no
// `excelFirstRowHeader.sourceRow`, because an auto-detected header is always
// the first row. Found by the desktop smoke suite: the host and the webview read
// the missing row as "no header", put the Header Row in the body layout, and
// displayed an inserted row one row too low.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { simulate_process_restart_for_tests } from '../viewer-controller';
import { header_body_start } from '../worksheet-layout';
import { sheet_body_start } from '../webview/formula-anchor-model';
import { parse_xlsx } from '../parse-xlsx';
import { own_structural_basis } from '../pending-changes';
import type { WorksheetPendingEdits } from '../types';
import { structural_bases_equal } from '../structural-save';
import { build_fixture_xlsx, cell, row } from './helpers/xlsx-structure-fixture';
import { open_xlsx, part_text } from './helpers/xlsx-viewer';
import * as vscode_mock from './mocks/vscode';

afterEach(() => {
    for (const panel of vscode_mock.__getPanels()) panel.dispose();
    vi.restoreAllMocks();
    vscode_mock.__reset();
    simulate_process_restart_for_tests();
});

// People: Header Row Name/Age/Active/Joined, body rows Alice and Bob.
const BASIC = new Uint8Array(readFileSync(join(__dirname, 'fixtures', 'basic.xlsx')));

describe('header_body_start', () => {
    it('puts the body after an auto-detected Header Row that names no source row', () => {
        expect(header_body_start({ active: true })).toBe(1);
        expect(header_body_start({ active: true, sourceRow: 3 })).toBe(4);
        expect(header_body_start({ active: false })).toBe(0);
        expect(header_body_start(undefined)).toBe(0);
        expect(sheet_body_start({
            excelFirstRowHeader: { mode: 'auto', detected: true, active: true, available: true },
        })).toBe(1);
    });
});

/** Open People and admit one row inserted after Alice. */
async function open_with_insert() {
    const viewer = await open_xlsx(BASIC);
    const insert = await viewer.insert({ requestId: 'insert', anchor: 1, side: 'after' });
    expect(insert).toMatchObject({ granted: true });
    await viewer.settle('insert', true);
    const id = insert.rowIds![0]!;
    const pending = {
        formatTemplates: [insert.formatTemplate!],
        appendedRows: [{
            id,
            origin: 'insert' as const,
            cells: { 0: { value: 'Cara' } },
            formatTemplateId: insert.formatTemplate!.id,
            createdOrder: 1,
        }],
        appendBasis: insert.appendBasis!,
        structuralBasis: viewer.basis(0),
    };
    const layout = (first_body_row: number) => ({
        runs: [
            { kind: 'source' as const, start: first_body_row, count: 2 - first_body_row },
            { kind: 'pending' as const, ids: [id] },
            { kind: 'source' as const, start: 2, count: 1 },
        ],
        removedSourceRows: [],
        discardedPendingRows: [],
    });
    return { viewer, pending, layout };
}

describe('row structure under an auto-detected Header Row', () => {
    it('is the case where the snapshot names no Header Row source row', async () => {
        const viewer = await open_xlsx(BASIC);
        const snapshot = viewer.messages().filter((message) => message.type === 'workbookSnapshot').at(-1) as unknown as {
            snapshot: { meta: { sheets: { excelFirstRowHeader?: { active: boolean; sourceRow?: number } }[] } };
        };
        const header = snapshot.snapshot.meta.sheets[0]!.excelFirstRowHeader;
        expect(header).toMatchObject({ active: true });
        expect(header?.sourceRow).toBeUndefined();
        viewer.dispose();
    });

    it('refuses a layout that puts the Header Row in the body', async () => {
        const { viewer, pending, layout } = await open_with_insert();
        expect(await viewer.publish(0, { ...pending, rowLayout: layout(0) })).toBe(false);
        viewer.dispose();
    });

    it('saves an insert between the body rows, below the Header Row', async () => {
        const { viewer, pending, layout } = await open_with_insert();
        const structural = { ...pending, rowLayout: layout(1) };
        expect(await viewer.publish(0, structural)).toBe(true);
        const saved = await viewer.save([{ sheetIndex: 0, structural }]);
        expect(saved).toMatchObject({ success: true });
        const parsed = await parse_xlsx(viewer.file.bytes);
        expect(parsed.data.sheets[0]!.rows.map((row) => row[0]?.formatted))
            .toEqual(['Name', 'Alice', 'Cara', 'Bob']);
        viewer.dispose();
    });
});

describe('a draft anchored before the Header Row left the body', () => {
    // Before `header_body_start`, an auto-detected Header Row gave body start 0,
    // so anchoring stored a reference to row 1 as the identity of source row 0.
    // Anchoring runs with the flag off, for any reference that lands on a
    // Pending Appended Row, so such drafts can be on disk.
    const FORMULA = '=COUNTA(A1:A4)';
    const column_a = { kind: 'identity' as const, column: { kind: 'source' as const, sourceColumn: 0 } };

    it('keeps a restored reference to the Header Row when it saves', async () => {
        const first = await open_xlsx(BASIC, { structuralEditingEnabled: false });
        const append = await first.append('append', 1);
        expect(append).toMatchObject({ granted: true });
        await first.settle('append', true);
        const id = append.rowIds![0]!;
        const draft = {
            formatTemplates: [append.formatTemplate!],
            appendedRows: [{
                id,
                cells: {
                    1: {
                        value: FORMULA,
                        formulaAnchors: {
                            references: [{
                                start: 8,
                                end: 13,
                                corners: [
                                    { row: { kind: 'identity' as const, row: { kind: 'source' as const, sourceRow: 0 } }, column: column_a },
                                    { row: { kind: 'identity' as const, row: { kind: 'pending' as const, pendingRowId: id } }, column: column_a },
                                ],
                            }],
                        },
                    },
                },
                formatTemplateId: append.formatTemplate!.id,
                createdOrder: 1,
            }],
            appendBasis: append.appendBasis!,
        };
        expect(await first.publish(0, draft)).toBe(true);
        first.dispose();

        const restored = await open_xlsx(BASIC, {
            store: first.store,
            disk: first.file,
            structuralEditingEnabled: false,
        });
        const pending = restored.durable().pendingEdits![0]!;
        expect(pending.appendedRows?.map((row) => row.id)).toEqual([id]);
        const saved = await restored.save([{ sheetIndex: 0, structural: pending as never }]);
        expect(saved).toMatchObject({ success: true });
        expect(part_text(restored.file.bytes, 'xl/worksheets/sheet1.xml'))
            .toContain('<f>COUNTA(A1:A4)</f>');
        restored.dispose();
    });
});

describe('an external edit that turns on an auto-detected Header Row', () => {
    // Data rows 1-4 of numbers have no detected header; the edit makes row 1
    // text, which the detector promotes, so the body start moves from 0 to 1
    // under a layout authored at 0.
    const book = (first: readonly [string | number, string | number]) => build_fixture_xlsx({ sheets: [{
        name: 'Data',
        body: `<sheetData>${[first, [3, 4], [5, 6], [7, 8]].map((cells, index) =>
            row(index + 1, cells.map((value, column) => cell(`${'AB'[column]}${index + 1}`, value)))).join('')}</sheetData>`,
    }] });
    const header = (viewer: Awaited<ReturnType<typeof open_xlsx>>) => (viewer.messages()
        .filter((message) => message.type === 'workbookSnapshot').at(-1) as unknown as {
            snapshot: { meta: { sheets: { excelFirstRowHeader?: { active: boolean } }[] } };
        }).snapshot.meta.sheets[0]!.excelFirstRowHeader?.active;

    /** Insert after row 1 and delete row 2, then make row 1 a header on disk. */
    async function conflicted() {
        const viewer = await open_xlsx(book([1, 2]));
        expect(header(viewer)).toBe(false);
        const insert = await viewer.insert({ requestId: 'insert', anchor: 0, side: 'after' });
        expect(insert).toMatchObject({ granted: true, structuralBasis: { bodyStart: 0 } });
        await viewer.settle('insert', true);
        const id = insert.rowIds![0]!;
        const changes = {
            formatTemplates: [insert.formatTemplate!],
            appendedRows: [{
                id,
                origin: 'insert' as const,
                cells: { 0: { value: '9' } },
                formatTemplateId: insert.formatTemplate!.id,
                createdOrder: 1,
            }],
            appendBasis: insert.appendBasis!,
            rowLayout: {
                runs: [
                    { kind: 'source' as const, start: 0, count: 1 },
                    { kind: 'pending' as const, ids: [id] },
                    { kind: 'source' as const, start: 1, count: 3 },
                ],
                removedSourceRows: [{ start: 1, count: 1 }],
                discardedPendingRows: [],
            },
            structuralBasis: insert.structuralBasis!,
        };
        expect(await viewer.publish(0, changes)).toBe(true);

        await viewer.change(book(['x', 'y']));
        expect(header(viewer)).toBe(true);
        // The host keeps the layout, records the conflict, and reconciles the
        // rows' append basis to the new schema, as it does for appended rows.
        const durable = (viewer.messages().filter((message) => message.type === 'workbookSnapshot').at(-1) as unknown as {
            snapshot: { state: { pendingEdits: WorksheetPendingEdits[] } };
        }).snapshot.state.pendingEdits[0]!;
        expect(durable.rowLayout).toEqual(changes.rowLayout);
        expect((durable.conflicts ?? []).map((conflict) => conflict.reason))
            .toEqual(['structuralBasisChanged']);
        expect(durable.appendBasis?.schemaFingerprint).not.toBe(changes.appendBasis.schemaFingerprint);
        // A cell-edit flush republishes the conflicted layout as the host
        // projects it, against the body start it was authored at.
        const flushed = { ...changes, appendBasis: durable.appendBasis!, conflicts: durable.conflicts ?? [] };
        expect(await viewer.publish(0, flushed)).toBe(true);
        return { viewer, changes: flushed };
    }

    it('keeps the new rows at the end, and saves them', async () => {
        const { viewer, changes } = await conflicted();
        const kept = {
            formatTemplates: changes.formatTemplates,
            appendedRows: [{ ...changes.appendedRows[0]!, origin: 'append' as const, createdOrder: 2 }],
            appendBasis: changes.appendBasis,
        };
        expect(await viewer.publish(0, kept)).toBe(true);
        const saved = await viewer.save([{ sheetIndex: 0, structural: kept }]);
        expect(saved).toMatchObject({ success: true });
        const parsed = await parse_xlsx(viewer.file.bytes);
        expect(parsed.data.sheets[0]!.rows.map((cells) => cells[0]?.formatted))
            .toEqual(['x', '3', '5', '7', '9']);
        viewer.dispose();
    });

    it('discards the row and column changes', async () => {
        const { viewer } = await conflicted();
        expect(await viewer.publish(0, {})).toBe(true);
        expect(viewer.durable().pendingEdits?.[0]?.rowLayout).toBeUndefined();
        viewer.dispose();
    });
});

describe('a Structural Basis recorded before bodyStart', () => {
    const recorded = {
        kind: 'xlsx' as const,
        worksheetPartDigest: 'a',
        sharedStringsDigest: null,
        stylesDigest: null,
        workbookDigest: 'b',
        sourceRowCount: 3,
        sourceColumnCount: 4,
    };

    it('still decodes, and still matches the same file', () => {
        expect(own_structural_basis(recorded)).toEqual(recorded);
        expect(own_structural_basis({ ...recorded, bodyStart: 1 })).toEqual({ ...recorded, bodyStart: 1 });
        expect(structural_bases_equal(recorded, { ...recorded, bodyStart: 1 })).toBe(true);
        expect(structural_bases_equal({ ...recorded, bodyStart: 0 }, { ...recorded, bodyStart: 1 })).toBe(false);
        expect(structural_bases_equal(recorded, { ...recorded, workbookDigest: 'c', bodyStart: 1 })).toBe(false);
        expect(() => own_structural_basis({ ...recorded, bodyStart: 4 })).toThrow();
    });
});
