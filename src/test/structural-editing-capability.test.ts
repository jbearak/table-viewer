import { describe, expect, it } from 'vitest';
import {
    current_structural_basis,
    STRUCTURE_NOT_AVAILABLE_YET,
    structural_editing_capability,
} from '../structural-editing-capability';
import { TOO_WIDE_TO_RESTRUCTURE_MESSAGE } from '../worksheet-layout';
import { observe_xlsx_structure } from '../xlsx-structural-observation';
import { build_fixture_xlsx, cell, representative_workbook, row } from './helpers/xlsx-structure-fixture';

const observation = { digest: 'abc', byteLength: 12 };
const sheet = { sourceRowCount: 5, columnCount: 3 };

describe('current_structural_basis', () => {
    it('describes a delimited file by its bytes and the worksheet counts', () => {
        expect(current_structural_basis('csv', observation, sheet, 0)).toEqual({
            kind: 'delimited',
            byteLength: 12,
            digest: 'abc',
            sourceRowCount: 5,
            sourceColumnCount: 3,
        });
        expect(current_structural_basis('tsv', observation, sheet, 0)?.kind).toBe('delimited');
    });

    it('has none without a byte length, or for .xlsx without part digests', () => {
        expect(current_structural_basis('xlsx', observation, sheet, 0)).toBeUndefined();
        expect(current_structural_basis('csv', { digest: 'abc' }, sheet, 0)).toBeUndefined();
        expect(current_structural_basis('csv', undefined, sheet, 0)).toBeUndefined();
    });

    it('describes an .xlsx worksheet by the digests of the parts its save reads', () => {
        const structure = observe_xlsx_structure(representative_workbook());
        const parts = structure.parts!;
        const xlsx = { digest: 'whole-file', byteLength: 1, xlsxStructure: structure };
        expect(current_structural_basis('xlsx', xlsx, sheet, 1)).toEqual({
            kind: 'xlsx',
            worksheetPartDigest: parts.worksheetPartDigests[1],
            sharedStringsDigest: parts.sharedStringsDigest,
            stylesDigest: parts.stylesDigest,
            workbookDigest: parts.workbookDigest,
            sourceRowCount: 5,
            sourceColumnCount: 3,
            bodyStart: 0,
        });
        expect(parts.worksheetPartDigests[0]).not.toBe(parts.worksheetPartDigests[1]);
        expect(current_structural_basis('xlsx', xlsx, sheet, 2)).toBeUndefined();
    });
});

describe('structural_editing_capability', () => {
    it('reports .xlsx worksheets unsupported without a structure observation', () => {
        const unsupported = { supported: false, reason: STRUCTURE_NOT_AVAILABLE_YET };
        expect(structural_editing_capability('xlsx', observation, [sheet, sheet])).toEqual({
            sheets: [
                { rows: unsupported, columns: unsupported },
                { rows: unsupported, columns: unsupported },
            ],
        });
    });

    it('reports each .xlsx worksheet and axis as the support scan answers, with its reason', () => {
        const raw = build_fixture_xlsx({
            sheets: [
                { name: 'Plain', body: `<sheetData>${row(1, [cell('A1', 1)])}</sheetData><mergeCells count="1"><mergeCell ref="A1:B1"/></mergeCells>` },
                { name: 'Spill', body: `<sheetData>${row(1, [cell('A1', { f: 'SUM(B1#)' })])}</sheetData>` },
            ],
        });
        const capability = structural_editing_capability(
            'xlsx',
            { digest: 'x', byteLength: raw.byteLength, xlsxStructure: observe_xlsx_structure(raw) },
            [{ sourceRowCount: 1, columnCount: 2 }, { sourceRowCount: 1, columnCount: 1 }],
        );
        expect(capability.sheets[0]).toMatchObject({
            rows: { supported: true },
            columns: { supported: true },
            basis: { kind: 'xlsx' },
            merges: ['A1:B1'],
            relativeRules: [],
        });
        const refused = capability.sheets[1]!.rows;
        expect(refused.supported).toBe(false);
        expect(refused.supported === false && refused.reason).toMatch(/^Can't insert or delete rows on this sheet: /);
        expect(refused.supported === false && refused.moveReason).toMatch(/^Can't move rows on this sheet: /);
    });

    it('refuses columns on a delimited source wider than Table Viewer can restructure', () => {
        const [wide] = structural_editing_capability('csv', observation, [{ sourceRowCount: 1, columnCount: 300 }]).sheets;
        expect(wide.rows).toEqual({ supported: true });
        expect(wide.columns).toEqual({ supported: false, reason: TOO_WIDE_TO_RESTRUCTURE_MESSAGE });
    });

    it("carries a delimited sheet's shortest record width for the padding note", () => {
        const [csv] = structural_editing_capability('csv', observation, [sheet], [2]).sheets;
        expect(csv.shortestRowWidth).toBe(2);
        const [unknown] = structural_editing_capability('csv', observation, [sheet]).sheets;
        expect(unknown).not.toHaveProperty('shortestRowWidth');
    });
});
