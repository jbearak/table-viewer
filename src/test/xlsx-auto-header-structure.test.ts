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
import { open_xlsx } from './helpers/xlsx-viewer';
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
