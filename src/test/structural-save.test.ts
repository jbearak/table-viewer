// Structural save, pure pieces (row and column structure design, delivery
// step 5): the CSV/TSV planner writing a row layout, the worksheet structure
// receipt, the Structural Basis and its prefix-growth test, the post-write
// rekey of durable view state, and the recovery shape hint.
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { build_csv_source, plan_csv_save, type SavePlanInput } from '../viewer-controller';
import type { PendingStructuralChanges, StructuralBasis } from '../pending-changes';
import type { RowLayout } from '../worksheet-layout';
import {
    apply_structural_rekey,
    current_structural_basis,
    delimited_records_of,
    ends_with_unquoted_record_terminator,
    is_delimited_prefix_growth,
    prospective_transform_schema,
    rebase_row_layout_on_growth,
    structural_receipt_shape_matches,
    structural_rekey_transition,
    structure_row_mapper,
    without_parked_structural_payloads,
    worksheet_structure_receipt,
    PARKED_STRUCTURAL_PAYLOAD_PREFIX,
} from '../structural-save';
import {
    own_structural_rekey_intent,
    transform_schema_for_sheet,
    type PendingChangesSaveReceipt,
    type PerFileState,
    type StructuralRekeyIntent,
} from '../types';

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function basis_of(bytes: Uint8Array, rows: number, columns: number): StructuralBasis {
    return {
        kind: 'delimited',
        byteLength: bytes.byteLength,
        digest: `sha256:${createHash('sha256').update(bytes).digest('hex')}`,
        sourceRowCount: rows,
        sourceColumnCount: columns,
    };
}

function changes(
    layout: RowLayout | undefined,
    basis: StructuralBasis | undefined,
    extra: Partial<PendingStructuralChanges> = {},
): PendingStructuralChanges {
    return {
        formatTemplates: [],
        appendedRows: [],
        tailRemovals: [],
        conflicts: [],
        ...(layout === undefined ? {} : { rowLayout: layout }),
        ...(basis === undefined ? {} : { structuralBasis: basis }),
        ...extra,
    };
}

async function plan(
    text: string,
    file_path: string,
    structural: PendingStructuralChanges | ((bytes: Uint8Array) => PendingStructuralChanges) | undefined,
    edits: Record<string, string> = {},
) {
    const bytes = encoder.encode(text);
    const source = await build_csv_source(bytes, file_path);
    const input: SavePlanInput = {
        source,
        file_path,
        worksheets: [{
            sheet_index: 0,
            edits,
            wanted_bases: new Set(Object.keys(edits)),
            structural_changes: typeof structural === 'function' ? structural(bytes) : structural,
        }],
    };
    const result = plan_csv_save(input);
    return { bytes, output: decoder.decode(result.produce(bytes)), result };
}

const APPEND_TEMPLATE = { id: 'plain', format: { kind: 'none' as const } };

function append_basis(columns: number, names: string[], rows: number) {
    return {
        sourceRowCount: rows,
        columnCount: columns,
        schemaFingerprint: `sha256:${createHash('sha256').update(JSON.stringify({
            columnCount: columns,
            columnNames: names,
        })).digest('hex')}`,
    };
}

describe('plan_csv_save with a row layout', () => {
    for (const [label, newline] of [['LF', '\n'], ['CRLF', '\r\n'], ['CR', '\r']] as const) {
        for (const [format, delimiter, path] of [['CSV', ',', '/tmp/s.csv'], ['TSV', '\t', '/tmp/s.tsv']] as const) {
            it(`deletes rows from a ${format} file with ${label} newlines`, async () => {
                const lines = ['h1', 'h2', 'a1', 'a2', 'b1', 'b2', 'c1', 'c2', 'd1', 'd2']
                    .reduce<string[][]>((rows, cell, index) => {
                        if (index % 2 === 0) rows.push([cell]);
                        else rows[rows.length - 1]!.push(cell);
                        return rows;
                    }, []);
                const text = lines.map((row) => row.join(delimiter)).join(newline) + newline;
                const { output, result } = await plan(text, path, (bytes) => changes({
                    runs: [{ kind: 'source', start: 0, count: 4 }],
                    removedSourceRows: [{ start: 1, count: 2 }],
                    discardedPendingRows: [],
                }, basis_of(bytes, 4, 2)));
                expect(output).toBe(['h1', 'h2', 'a1', 'a2', 'd1', 'd2']
                    .reduce<string[]>((rows, cell, index) => {
                        if (index % 2 === 0) rows.push(cell);
                        else rows[rows.length - 1] += delimiter + cell;
                        return rows;
                    }, []).join(newline) + newline);
                expect(result.receipt?.structure).toEqual([{
                    sheetIndex: 0,
                    sheetName: 'Sheet1',
                    rowRuns: [
                        { from: 0, count: 1, to: 0 },
                        { from: 3, count: 1, to: 1 },
                    ],
                    removedRows: [{ start: 1, count: 2 }],
                    columnMap: [0, 1],
                    insertedRows: [],
                    insertedColumns: [],
                }]);
            });
        }
    }

    it('writes appended rows after the live body and assigns them H + N + i', async () => {
        const text = 'name,qty\na,1\nb,2\nc,3\n';
        const { output, result } = await plan(text, '/tmp/s.csv', (bytes) => changes({
            runs: [{ kind: 'source', start: 0, count: 3 }],
            removedSourceRows: [{ start: 0, count: 1 }],
            discardedPendingRows: [],
        }, basis_of(bytes, 3, 2), {
            formatTemplates: [APPEND_TEMPLATE],
            appendBasis: append_basis(2, ['name', 'qty'], 3),
            appendedRows: [
                { id: 'p1', cells: { 0: { value: 'x' } }, formatTemplateId: 'plain', createdOrder: 1 },
                { id: 'p2', cells: { 1: { value: '9' } }, formatTemplateId: 'plain', createdOrder: 2 },
            ],
        }));
        expect(output).toBe('name,qty\nb,2\nc,3\nx,\n,9\n');
        expect(result.receipt?.appendedRows.map((row) => [row.pendingRowId, row.sourceRow]))
            .toEqual([['p1', 2], ['p2', 3]]);
        expect(result.receipt?.structure?.[0]?.rowRuns).toEqual([{ from: 1, count: 2, to: 0 }]);
    });

    it('streams a source run placed out of order with its own window reads', async () => {
        const text = 'h\n0\n1\n2\n3\n4\n';
        const { output, result } = await plan(text, '/tmp/s.csv', (bytes) => changes({
            runs: [
                { kind: 'source', start: 3, count: 2 },
                { kind: 'source', start: 0, count: 3 },
            ],
            removedSourceRows: [{ start: 1, count: 1 }, { start: 4, count: 1 }],
            discardedPendingRows: [],
        }, basis_of(bytes, 5, 1)), { '3:0': 'three', '0:0': 'zero' });
        expect(output).toBe('h\nthree\nzero\n2\n');
        expect(result.observed_bases[0]).toEqual(new Map([['3:0', '3'], ['0:0', '0']]));
        expect(result.receipt?.structure?.[0]?.rowRuns).toEqual([
            { from: 0, count: 1, to: 1 },
            { from: 2, count: 1, to: 2 },
            { from: 3, count: 1, to: 0 },
        ]);
    });

    it('keeps a save without a live layout change byte-identical', async () => {
        const text = 'h,"q ""x"""\r\n1,"a\r\nb"\r\n2\r\n';
        const plain = await plan(text, '/tmp/s.csv', undefined, { '1:1': 'z' });
        const tombstones_only = await plan(text, '/tmp/s.csv', changes({
            runs: [{ kind: 'source', start: 0, count: 2 }],
            removedSourceRows: [],
            discardedPendingRows: [],
        }, undefined), { '1:1': 'z' });
        expect(plain.output).toBe('h,"q ""x"""\r\n1,"a\r\nb"\r\n2,z\r\n');
        expect(tombstones_only.output).toBe(plain.output);
        expect(plain.result.receipt?.structure).toBeUndefined();
        expect(tombstones_only.result.receipt?.structure).toBeUndefined();
    });

    it('refuses a layout whose basis does not describe the source', async () => {
        await expect(plan('h\na\nb\n', '/tmp/s.csv', (bytes) => changes({
            runs: [{ kind: 'source', start: 0, count: 2 }],
            removedSourceRows: [{ start: 0, count: 1 }],
            discardedPendingRows: [],
        }, basis_of(bytes, 3, 1)))).rejects.toMatchObject({
            name: 'PendingStructuralSaveError',
            conflict: { reason: 'structuralBasisChanged' },
        });
    });

    it('refuses a cell edit on a removed row and an invalid layout as internal errors', async () => {
        const removal = (bytes: Uint8Array) => changes({
            runs: [{ kind: 'source', start: 0, count: 2 }],
            removedSourceRows: [{ start: 0, count: 1 }],
            discardedPendingRows: [],
        }, basis_of(bytes, 2, 1));
        await expect(plan('h\na\nb\n', '/tmp/s.csv', removal, { '0:0': 'x' }))
            .rejects.toThrow('addresses a removed row');
        await expect(plan('h\na\nb\n', '/tmp/s.csv', (bytes) => changes({
            runs: [{ kind: 'source', start: 0, count: 1 }],
            removedSourceRows: [{ start: 0, count: 1 }],
            discardedPendingRows: [],
        }, basis_of(bytes, 2, 1)))).rejects.toThrow('inconsistent');
    });

    it('refuses inserted rows until inserting can be saved', async () => {
        await expect(plan('h\na\n', '/tmp/s.csv', (bytes) => changes({
            runs: [{ kind: 'source', start: 0, count: 1 }, { kind: 'pending', ids: ['ins'] }],
            removedSourceRows: [],
            discardedPendingRows: [],
        }, basis_of(bytes, 1, 1), {
            formatTemplates: [APPEND_TEMPLATE],
            appendBasis: append_basis(1, ['h'], 1),
            appendedRows: [{ id: 'ins', origin: 'insert', cells: {}, formatTemplateId: 'plain', createdOrder: 1 }],
        }))).rejects.toThrow('Saving inserted rows is not available yet.');
    });

    it('writes a layout whose every body row is removed as the header alone', async () => {
        const { output } = await plan('h\na\nb\n', '/tmp/s.csv', (bytes) => changes({
            runs: [{ kind: 'source', start: 0, count: 2 }],
            removedSourceRows: [{ start: 0, count: 2 }],
            discardedPendingRows: [],
        }, basis_of(bytes, 2, 1)));
        expect(output).toBe('h\n');
    });
});

describe('worksheet_structure_receipt', () => {
    it('offsets body indexes by the Header Row and reports the identity column map', () => {
        expect(worksheet_structure_receipt(
            { sheetIndex: 1, sheetName: 'Sales', worksheetId: 'w' },
            {
                rowLayout: {
                    runs: [
                        { kind: 'source', start: 6, count: 2 },
                        { kind: 'source', start: 3, count: 3 },
                    ],
                    removedSourceRows: [{ start: 4, count: 1 }],
                    discardedPendingRows: [],
                },
            },
            { bodyStart: 3, sourceRowCount: 8, sourceColumnCount: 2 },
        )).toEqual({
            sheetIndex: 1,
            sheetName: 'Sales',
            worksheetId: 'w',
            rowRuns: [
                { from: 3, count: 1, to: 5 },
                { from: 5, count: 1, to: 6 },
                { from: 6, count: 2, to: 3 },
            ],
            removedRows: [{ start: 4, count: 1 }],
            columnMap: [0, 1],
            insertedRows: [],
            insertedColumns: [],
        });
    });

    it('round-trips through the stored rekey intent codec', () => {
        const entry = worksheet_structure_receipt(
            { sheetIndex: 0, sheetName: 'Sheet1' },
            { rowLayout: { runs: [{ kind: 'source', start: 0, count: 3 }], removedSourceRows: [{ start: 1, count: 1 }], discardedPendingRows: [] } },
            { bodyStart: 0, sourceRowCount: 3, sourceColumnCount: 1 },
        );
        const intent = {
            saveId: 's',
            beforeDigest: 'b',
            afterDigest: 'a',
            worksheets: [{ sheetIndex: 0, sheetName: 'Sheet1', acceptedSequence: 2 }],
            receipt: { appendedRows: [], removedSourceRows: [], structure: [entry] },
        };
        expect(own_structural_rekey_intent(JSON.parse(JSON.stringify(intent)))).toEqual(intent);
        expect(() => own_structural_rekey_intent({
            ...intent,
            receipt: { ...intent.receipt, structure: [{ ...entry, extra: 1 }] },
        })).toThrow();
        expect(() => own_structural_rekey_intent({
            ...intent,
            receipt: { ...intent.receipt, structure: [{ ...entry, rowRuns: [{ from: 0, count: 0, to: 0 }] }] },
        })).toThrow();
    });

    it('maps rows through the receipt', () => {
        const map = structure_row_mapper({
            sheetIndex: 0,
            rowRuns: [{ from: 2, count: 2, to: 2 }, { from: 5, count: 1, to: 4 }],
            removedRows: [{ start: 4, count: 1 }],
            columnMap: [0],
            insertedRows: [],
            insertedColumns: [],
        });
        expect([0, 1, 2, 3, 4, 5, 6].map(map)).toEqual([0, 1, 2, 3, null, 4, null]);
    });
});

describe('Structural Basis', () => {
    const old_text = 'h,v\na,1\n"b\nb",2\n';
    const old_bytes = encoder.encode(old_text);
    const basis = basis_of(old_bytes, 2, 2) as Extract<StructuralBasis, { kind: 'delimited' }>;
    const parse = (bytes: Uint8Array) => delimited_records_of(bytes, ',');

    it('records the byte length and digest with the source dimensions', async () => {
        const source = await build_csv_source(old_bytes, '/tmp/s.csv');
        expect(current_structural_basis(old_bytes, source.meta().sheets[0]!)).toEqual(basis);
    });

    it('accepts rows appended after an unquoted record terminator', () => {
        expect(is_delimited_prefix_growth(basis, encoder.encode(`${old_text}c,3\nd,4\n`), ',', parse)).toBe(true);
    });

    it.each([
        ['the same bytes', old_text],
        ['a changed old record', 'h,v\na,9\n"b\nb",2\nc,3\n'],
        ['a changed header', 'h,w\na,1\n"b\nb",2\nc,3\n'],
        ['a wider record', `${old_text}c,3,x\n`],
        ['a shorter file', 'h,v\na,1\n'],
    ])('refuses %s', (_label, text) => {
        expect(is_delimited_prefix_growth(basis, encoder.encode(text), ',', parse)).toBe(false);
    });

    it('refuses growth that continues the old last record', () => {
        const unterminated = encoder.encode('h,v\na,1');
        const old = basis_of(unterminated, 1, 2) as Extract<StructuralBasis, { kind: 'delimited' }>;
        expect(is_delimited_prefix_growth(old, encoder.encode('h,v\na,1\nb,2\n'), ',', parse)).toBe(false);
    });

    it('refuses growth when the old content ended inside a quoted field', () => {
        const inside = encoder.encode('h,v\na,"1\n');
        expect(ends_with_unquoted_record_terminator(inside, ',')).toBe(false);
        expect(ends_with_unquoted_record_terminator(encoder.encode('h,v\na,"1"\n'), ',')).toBe(true);
        expect(ends_with_unquoted_record_terminator(encoder.encode('h\tv\r'), '\t')).toBe(true);
        const old = basis_of(inside, 1, 2) as Extract<StructuralBasis, { kind: 'delimited' }>;
        expect(is_delimited_prefix_growth(old, encoder.encode('h,v\na,"1\n2"\nb,3\n'), ',', parse)).toBe(false);
    });

    it('joins new rows after the run holding the highest old row, wherever it moved', () => {
        expect(rebase_row_layout_on_growth({
            runs: [{ kind: 'source', start: 3, count: 2 }, { kind: 'source', start: 0, count: 3 }],
            removedSourceRows: [{ start: 4, count: 1 }],
            discardedPendingRows: [],
        }, 0, 5, 7)).toEqual({
            runs: [{ kind: 'source', start: 3, count: 4 }, { kind: 'source', start: 0, count: 3 }],
            removedSourceRows: [{ start: 4, count: 1 }],
            discardedPendingRows: [],
        });
        expect(rebase_row_layout_on_growth(
            { runs: [], removedSourceRows: [], discardedPendingRows: [] },
            0,
            0,
            2,
        ).runs).toEqual([{ kind: 'source', start: 0, count: 2 }]);
    });
});

const SHEETS = [{ name: 'Sheet1' }, { name: 'Other' }];
const STRUCTURE = {
    sheetIndex: 0,
    sheetName: 'Sheet1',
    // Rows 0-4 and columns 0-2: row 1 removed, rows 3-4 moved to the top.
    rowRuns: [
        { from: 0, count: 1, to: 2 },
        { from: 2, count: 1, to: 3 },
        { from: 3, count: 2, to: 0 },
    ],
    removedRows: [{ start: 1, count: 1 }],
    columnMap: [1, null, 0],
    insertedRows: [{ pendingRowId: 'ins', sourceRow: 4 }],
    insertedColumns: [{ pendingColumnId: 'col', column: 2 }],
};

describe('apply_structural_rekey', () => {
    const payload: PendingStructuralChanges = {
        formatTemplates: [APPEND_TEMPLATE],
        appendedRows: [
            { id: 'ins', origin: 'insert', cells: {}, formatTemplateId: 'plain', createdOrder: 1, viewerRowHeight: 40, highlights: { 0: 'yellow' } },
            { id: 'app', cells: {}, formatTemplateId: 'plain', createdOrder: 2, viewerRowHeight: 30, highlights: { 2: 'green' } },
        ],
        tailRemovals: [],
        conflicts: [],
        pendingColumns: [{ id: 'col', header: 'New', cells: {}, format: { kind: 'none' }, createdOrder: 1, viewerWidth: 77, highlights: { 's:3': 'pink', 'p:ins': 'blue' } }],
    };
    const receipt: PendingChangesSaveReceipt = {
        appendedRows: [
            { sheetIndex: 0, sheetName: 'Sheet1', pendingRowId: 'app', sourceRow: 5, savedFingerprint: 'f' },
            { sheetIndex: 1, sheetName: 'Other', pendingRowId: 'o', sourceRow: 9, savedFingerprint: 'g', savedRow: { cells: {}, format: { kind: 'none' }, viewerRowHeight: 12, highlights: { 0: 'green' } } },
        ],
        removedSourceRows: [{ sheetIndex: 1, sheetName: 'Other', sourceRows: [8] }],
        structure: [STRUCTURE],
    };
    const state: PerFileState = {
        cellHighlights: {
            sourceDigest: 'before',
            sheets: [
                { schema: 'old', cells: { '0:0': 'pink', '1:0': 'pink', '3:2': 'blue', '2:1': 'green' } },
                { schema: 'other', cells: { '8:0': 'pink', '7:0': 'blue' } },
            ],
        },
        rowHeights: [{ 0: 20, 1: 21, 4: 24 }, { 7: 17, 8: 18 }],
        columnWidths: [{ 0: 100, 1: 101, 2: 102 }],
        transforms: [{
            sort: [{ colIndex: 1, direction: 'asc' }, { colIndex: 2, direction: 'desc' }],
            filters: [
                { id: 'f1', colIndex: 0, operator: 'contains', value: 'x', enabled: true },
                { id: 'f2', colIndex: 1, operator: 'isEmpty', enabled: true },
            ],
            hiddenRows: [1, 2, 3],
            schema: 'old',
        }],
        columnVisibility: [{ hiddenColumns: [1, 2], schema: 'old' }],
    };

    const result = apply_structural_rekey(state, receipt, {
        sheets: SHEETS,
        afterDigest: 'after',
        schemaAfter: (index) => index === 0 ? 'new' : undefined,
        payload: (target) => target.sheetIndex === 0 ? payload : undefined,
        columnName: (_sheet, column) => ['Name', 'Price', 'Qty'][column],
    });

    it('rekeys cell highlights, dropping removed cells and adding Pending Row and Column highlights', () => {
        expect(result.state.cellHighlights).toEqual({
            sourceDigest: 'after',
            sheets: [
                {
                    schema: 'new',
                    cells: {
                        '2:1': 'pink',
                        '0:0': 'blue',
                        '4:1': 'yellow',
                        '5:0': 'green',
                        '0:2': 'pink',
                        '4:2': 'blue',
                    },
                },
                { schema: 'other', cells: { '7:0': 'blue', '9:0': 'green' } },
            ],
        });
    });

    it('rekeys row heights, hidden rows, and column widths', () => {
        expect(result.state.rowHeights).toEqual([{ 2: 20, 1: 24, 4: 40, 5: 30 }, { 7: 17, 9: 12 }]);
        expect(result.state.transforms?.[0]?.hiddenRows).toEqual([0, 3]);
        expect(result.state.columnWidths).toEqual([{ 1: 100, 0: 102, 2: 77 }]);
    });

    it('drops sorts and filters on removed columns, with announcements, and moves the rest', () => {
        expect(result.state.transforms?.[0]).toMatchObject({
            sort: [{ colIndex: 0, direction: 'desc' }],
            filters: [{ id: 'f1', colIndex: 1 }],
            schema: 'new',
        });
        expect(result.announcements).toEqual([
            'Removed the sort on Price because the column was deleted.',
            'Removed the filter on Price because the column was deleted.',
        ]);
    });

    it('rekeys column visibility with the new schema', () => {
        expect(result.state.columnVisibility).toEqual([{ hiddenColumns: [0], schema: 'new' }]);
    });
});

describe('prospective_transform_schema', () => {
    const sheet = { name: 'Sheet1', columnCount: 3, columnNames: ['Name', 'Price', 'Qty'] };
    it('is the sheet schema when columns keep their places', () => {
        expect(prospective_transform_schema(sheet, { ...STRUCTURE, columnMap: [0, 1, 2], insertedColumns: [] }, undefined))
            .toBe(transform_schema_for_sheet(sheet as never));
    });
    it('moves names through the column map and places Pending Column headers', () => {
        expect(prospective_transform_schema(sheet, STRUCTURE, {
            formatTemplates: [], appendedRows: [], tailRemovals: [], conflicts: [],
            pendingColumns: [{ id: 'col', header: 'New', cells: {}, format: { kind: 'none' }, createdOrder: 1 }],
        })).toBe(JSON.stringify(['Sheet1', 3, ['Qty', 'Name', 'New']]));
    });
});

describe('structural_rekey_transition', () => {
    const intent: StructuralRekeyIntent = {
        saveId: 's',
        beforeDigest: 'before',
        afterDigest: 'after',
        worksheets: [{ sheetIndex: 0, sheetName: 'Sheet1', acceptedSequence: 3 }],
        receipt: {
            appendedRows: [],
            removedSourceRows: [],
            structure: [{ ...STRUCTURE, rowRuns: [{ from: 0, count: 1, to: 0 }, { from: 2, count: 3, to: 1 }], columnMap: [0, 1, 2], insertedRows: [], insertedColumns: [] }],
        },
    };
    const state: PerFileState = {
        pendingEdits: [{
            sheetName: 'Sheet1',
            cells: {},
            rowLayout: { runs: [{ kind: 'source', start: 0, count: 5 }], removedSourceRows: [{ start: 1, count: 1 }], discardedPendingRows: [] },
        }],
        rowHeights: [{ 2: 30 }],
        structuralRekeyIntent: intent,
    };
    const options = { schemaAfter: () => undefined };

    it('applies the rekey, retires the payload, and clears the intent in one state', () => {
        const next = structural_rekey_transition(state, intent, SHEETS, { ...options, retire: () => true }).state;
        expect(next.structuralRekeyIntent).toBeUndefined();
        expect(next.pendingEdits).toBeUndefined();
        expect(next.rowHeights).toEqual([{ 1: 30 }]);
    });

    it('keeps a payload a later publication replaced', () => {
        const next = structural_rekey_transition(state, intent, SHEETS, { ...options, retire: () => false }).state;
        expect(next.structuralRekeyIntent).toBeUndefined();
        expect(next.pendingEdits?.[0]?.rowLayout).toBeDefined();
    });

    it('parks the payload for "It finished", until the next successful save drops it', () => {
        const next = structural_rekey_transition(state, intent, SHEETS, { ...options, retire: () => true, park: true }).state;
        expect(next.pendingEdits).toEqual([{
            ...state.pendingEdits![0],
            sheetName: `${PARKED_STRUCTURAL_PAYLOAD_PREFIX}Sheet1`,
        }]);
        expect(without_parked_structural_payloads(next).pendingEdits).toBeUndefined();
    });
});

describe('structural_receipt_shape_matches', () => {
    const receipt: PendingChangesSaveReceipt = {
        appendedRows: [{ sheetIndex: 0, sheetName: 'Sheet1', pendingRowId: 'a', sourceRow: 2, savedFingerprint: 'f' }],
        removedSourceRows: [],
        structure: [{
            sheetIndex: 0,
            sheetName: 'Sheet1',
            rowRuns: [{ from: 0, count: 2, to: 0 }],
            removedRows: [{ start: 2, count: 1 }],
            columnMap: [0, 1],
            insertedRows: [],
            insertedColumns: [],
        }],
    };
    it('matches the row and column counts the save wrote', () => {
        const sheet = (rows: number, columns: number) => [{ name: 'Sheet1', sourceRowCount: rows, columnCount: columns }];
        expect(structural_receipt_shape_matches(receipt, sheet(3, 2), () => undefined)).toBe(true);
        expect(structural_receipt_shape_matches(receipt, sheet(4, 2), () => undefined)).toBe(false);
        expect(structural_receipt_shape_matches(receipt, sheet(3, 3), () => undefined)).toBe(false);
    });
});
