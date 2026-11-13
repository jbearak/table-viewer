// Non-structural `.xlsx` saves are byte-identical to the writer before the
// structural save stage existed (delivery step 9c): with structural editing
// on, a cell edit, a formula edit, and an append write exactly the bytes they
// wrote before. The digests below were produced by this same test on the
// commit before step 9c (437e4a8), with `PRINT_XLSX_SAVE_DIGESTS=1`.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { content_digest } from '../content-digest';
import { simulate_process_restart_for_tests } from '../viewer-controller';
import { open_xlsx } from './helpers/xlsx-viewer';
import { representative_workbook } from './helpers/xlsx-structure-fixture';
import * as vscode_mock from './mocks/vscode';

afterEach(() => {
    for (const panel of vscode_mock.__getPanels()) panel.dispose();
    vi.restoreAllMocks();
    vscode_mock.__reset();
    simulate_process_restart_for_tests();
});

const fixture = (name: string) => new Uint8Array(readFileSync(join(__dirname, 'fixtures', name)));

const GOLDEN: Record<string, string> = {
    'formatted.xlsx cell edit': 'a0cd08c9d75593e11d11c6a07a0047c5ad2748d7918c4eb3b94c766922090879',
    'formatted.xlsx append': '74f62932fcbe12b5148cfed7bf7183a57ebcc73d4f2e3d7ea5fd54916449e180',
    'representative cell and formula edit': '8c850be46e46630bbf9273e7486d278b27ebcf053b921e090cb167c5a245e2f7',
    'representative append': '76a556c6ecb65098032d4eeca4efe6c02ffa7e5d1096857a1111d43114a2ffde',
};

function check(label: string, bytes: Uint8Array): void {
    const digest = content_digest(bytes);
    if (process.env.PRINT_XLSX_SAVE_DIGESTS) console.log(`GOLDEN ${JSON.stringify(label)}: '${digest}',`);
    else expect([label, digest]).toEqual([label, GOLDEN[label]]);
}

describe('non-structural .xlsx saves with structural editing on', () => {
    it('write a cell edit byte for byte as before', async () => {
        const viewer = await open_xlsx(fixture('formatted.xlsx'));
        // The first attempt learns the cell's base from the host's rejection.
        const probe = await viewer.save([{ sheetIndex: 0, cells: { '0:0': { value: 'changed', base: '\u0000' } } }]);
        const base = (probe.rejection as { observedBases?: Record<string, { value: string }> }).observedBases!['0:0']!.value;
        const result = await viewer.save([{ sheetIndex: 0, cells: { '0:0': { value: 'changed', base } } }]);
        expect(result).toMatchObject({ success: true });
        check('formatted.xlsx cell edit', viewer.file.bytes);
    });

    it('write an append byte for byte as before', async () => {
        const viewer = await open_xlsx(fixture('formatted.xlsx'));
        const append = await viewer.append('append', 1);
        await viewer.settle('append', true);
        const result = await viewer.save([{
            sheetIndex: 0,
            structural: {
                formatTemplates: [append.formatTemplate!],
                appendedRows: [{
                    id: append.rowIds![0]!,
                    cells: { 0: { value: 'appended' } },
                    formatTemplateId: append.formatTemplate!.id,
                    createdOrder: 1,
                }],
                appendBasis: append.appendBasis!,
            },
        }]);
        expect(result).toMatchObject({ success: true });
        check('formatted.xlsx append', viewer.file.bytes);
    });

    it('write cell and formula edits on a workbook with cross-sheet formulas byte for byte as before', async () => {
        const viewer = await open_xlsx(representative_workbook({ calcChain: true }));
        const result = await viewer.save([
            { sheetIndex: 0, cells: { '2:1': { value: '6', base: '5' } } },
            { sheetIndex: 1, cells: { '1:1': { value: '=Data!B3*2', base: '=Data!B5' } } },
        ]);
        expect(result).toMatchObject({ success: true });
        check('representative cell and formula edit', viewer.file.bytes);
    });

    it('write an append on a workbook with cross-sheet formulas byte for byte as before', async () => {
        const viewer = await open_xlsx(representative_workbook({ calcChain: true }));
        const append = await viewer.append('append', 1);
        await viewer.settle('append', true);
        const result = await viewer.save([{
            sheetIndex: 0,
            structural: {
                formatTemplates: [append.formatTemplate!],
                appendedRows: [{
                    id: append.rowIds![0]!,
                    cells: { 0: { value: 'Grape' }, 1: { value: '4' } },
                    formatTemplateId: append.formatTemplate!.id,
                    createdOrder: 1,
                }],
                appendBasis: append.appendBasis!,
            },
        }]);
        expect(result).toMatchObject({ success: true });
        check('representative append', viewer.file.bytes);
    });
});
