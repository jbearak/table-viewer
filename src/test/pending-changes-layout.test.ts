// Delivery step 3 of the row and column structure design: the layout fields of
// the Pending Changes envelope, their strict durable and wire codecs, durable
// version 2, the Pending Row accessors, and the guard that keeps raw
// `appendedRows` reads inside the codecs.
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
    appended_rows,
    EMPTY_PENDING_STRUCTURAL_CHANGES,
    inserted_rows,
    own_pending_structural_changes,
    pending_changes_carry_layout,
    pending_rows,
    pending_structure_error,
    type PendingColumn,
    type PendingStructuralChanges,
    type StructuralBasis,
} from '../pending-changes';
import {
    decode_stored_per_file_state,
    is_wire_csv_save_rejection,
    own_structural_rekey_intent,
    own_wire_pending_changes,
    stored_pending_edits_version,
    stringify_stored_per_file_state,
    with_pending_edits_for_sheet,
    type PerFileState,
    type StructuralRekeyIntent,
    type WorksheetPendingEdits,
} from '../types';
import type { ColumnLayout, RowLayout } from '../worksheet-layout';

const TEMPLATE = { id: 'plain', format: { kind: 'none' as const } };

const BASIS: StructuralBasis = {
    kind: 'delimited',
    byteLength: 20,
    digest: 'sha256:abc',
    sourceRowCount: 4,
    sourceColumnCount: 3,
};

const XLSX_BASIS: StructuralBasis = {
    kind: 'xlsx',
    worksheetPartDigest: 'sheet',
    sharedStringsDigest: null,
    stylesDigest: 'styles',
    workbookDigest: 'workbook',
    sourceRowCount: 4,
    sourceColumnCount: 3,
};

/** Body rows 0-3; row 2 removed; inserted row `ins` after row 0. */
const ROW_LAYOUT: RowLayout = {
    runs: [
        { kind: 'source', start: 0, count: 1 },
        { kind: 'pending', ids: ['ins'] },
        { kind: 'source', start: 1, count: 3 },
    ],
    removedSourceRows: [{ start: 2, count: 1 }],
    discardedPendingRows: [],
};

/** Columns 0-2; column 1 moved last, Pending Column `pc` first. */
const COLUMN_LAYOUT: ColumnLayout = {
    columns: [
        { kind: 'pending', pendingColumnId: 'pc' },
        { kind: 'source', sourceColumn: 0 },
        { kind: 'source', sourceColumn: 2 },
        { kind: 'source', sourceColumn: 1 },
    ],
    removedSourceColumns: [],
    discardedPendingColumns: [],
};

const PENDING_COLUMN: PendingColumn = {
    id: 'pc',
    header: 'New',
    cells: { 's:0': { value: 'a' }, 'p:ins': { value: 'b' } },
    highlights: { 's:1': 'yellow' },
    viewerWidth: 120,
    format: { kind: 'none' },
    createdOrder: 5,
};

function structural(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
        formatTemplates: [TEMPLATE],
        appendedRows: [
            { id: 'app', cells: { 0: { value: 'x' } }, formatTemplateId: 'plain', createdOrder: 1 },
            { id: 'ins', origin: 'insert', cells: { 1: { value: 'y' } }, formatTemplateId: 'plain', createdOrder: 2 },
        ],
        tailRemovals: [],
        conflicts: [],
        rowLayout: ROW_LAYOUT,
        columnLayout: COLUMN_LAYOUT,
        pendingColumns: [PENDING_COLUMN],
        structuralBasis: BASIS,
        ...overrides,
    };
}

function owned(overrides: Record<string, unknown> = {}): PendingStructuralChanges {
    return own_pending_structural_changes(structural(overrides));
}

const INTENT: StructuralRekeyIntent = {
    saveId: 'save-1',
    beforeDigest: 'before',
    afterDigest: 'after',
    worksheets: [{ sheetIndex: 0, sheetName: 'Sheet1', acceptedSequence: 3 }],
    receipt: {
        appendedRows: [{
            sheetIndex: 0,
            sheetName: 'Sheet1',
            pendingRowId: 'app',
            sourceRow: 4,
            savedFingerprint: 'fp',
            savedCells: { 0: { value: 'x' } },
        }],
        removedSourceRows: [{ sheetIndex: 0, sourceRows: [2] }],
    },
};

describe('Pending Row accessors', () => {
    it('split rows by origin and keep the stored array when nothing is inserted', () => {
        const changes = owned();
        expect(pending_rows(changes).map((row) => row.id)).toEqual(['app', 'ins']);
        expect(appended_rows(changes).map((row) => row.id)).toEqual(['app']);
        expect(inserted_rows(changes).map((row) => row.id)).toEqual(['ins']);
        // Cached, so memoized consumers see a stable array.
        expect(appended_rows(changes)).toBe(appended_rows(changes));

        const appends_only = own_pending_structural_changes({
            formatTemplates: [TEMPLATE],
            appendedRows: [{ id: 'a', cells: {}, formatTemplateId: 'plain', createdOrder: 1 }],
        });
        expect(appended_rows(appends_only)).toBe(appends_only.appendedRows);
        expect(inserted_rows(appends_only)).toEqual([]);
        expect(pending_rows(undefined)).toEqual([]);
        expect(appended_rows({})).toEqual([]);
    });
});

describe('own_pending_structural_changes layout fields', () => {
    it('owns every new field', () => {
        const changes = owned();
        expect(changes.rowLayout).toEqual(ROW_LAYOUT);
        expect(changes.columnLayout).toEqual(COLUMN_LAYOUT);
        expect(changes.pendingColumns).toEqual([PENDING_COLUMN]);
        expect(changes.structuralBasis).toEqual(BASIS);
        expect(changes.appendedRows[1]?.origin).toBe('insert');
        expect(pending_changes_carry_layout(changes)).toBe(true);
        expect(own_pending_structural_changes(changes)).toEqual(changes);
        expect(owned({ structuralBasis: XLSX_BASIS }).structuralBasis).toEqual(XLSX_BASIS);
    });

    it('normalizes what writers omit: a source layout, an empty column list, origin append', () => {
        const changes = own_pending_structural_changes({
            formatTemplates: [TEMPLATE],
            appendedRows: [{ id: 'a', origin: 'append', cells: {}, formatTemplateId: 'plain', createdOrder: 1 }],
            rowLayout: { runs: [{ kind: 'source', start: 1, count: 3 }], removedSourceRows: [], discardedPendingRows: [] },
            columnLayout: {
                columns: [{ kind: 'source', sourceColumn: 0 }, { kind: 'source', sourceColumn: 1 }],
                removedSourceColumns: [],
                discardedPendingColumns: [],
            },
            pendingColumns: [],
        });
        expect(changes).toEqual({
            formatTemplates: [TEMPLATE],
            appendedRows: [{ id: 'a', cells: {}, formatTemplateId: 'plain', createdOrder: 1 }],
            tailRemovals: [],
            conflicts: [],
        });
        expect(pending_changes_carry_layout(changes)).toBe(false);
    });

    it('keeps legacy shapes decoding unchanged', () => {
        expect(own_pending_structural_changes({})).toEqual(EMPTY_PENDING_STRUCTURAL_CHANGES);
        const legacy = {
            formatTemplates: [TEMPLATE],
            appendedRows: [{ id: 'a', cells: { 0: { value: 'v' } }, formatTemplateId: 'plain', createdOrder: 1 }],
            tailRemovals: [],
            appendBasis: { sourceRowCount: 2, columnCount: 1, schemaFingerprint: 'fp' },
            conflicts: [],
        };
        expect(own_pending_structural_changes(legacy)).toEqual(legacy);
    });

    it('accepts the two new conflict reasons', () => {
        for (const reason of ['structuralBasisChanged', 'unsupportedStructure']) {
            expect(owned({
                conflicts: [{ reason, pendingRowIds: ['ins'], tailRemovalIds: [] }],
            }).conflicts[0]?.reason).toBe(reason);
            expect(is_wire_csv_save_rejection({
                reason: 'structuralConflict',
                worksheetOperationIndex: 0,
                structuralReason: reason,
                pendingRowIds: [],
                tailRemovalIds: [],
            })).toBe(true);
        }
        expect(() => owned({
            conflicts: [{ reason: 'somethingElse', pendingRowIds: [], tailRemovalIds: [] }],
        })).toThrow();
    });

    it.each<[string, Record<string, unknown>]>([
        ['an unknown origin', {
            appendedRows: [{ id: 'ins', origin: 'moved', cells: {}, formatTemplateId: 'plain', createdOrder: 2 }],
        }],
        ['an inserted row without a row layout', { rowLayout: undefined }],
        ['an appended row posing as an inserted row', {
            appendedRows: [
                { id: 'app', origin: 'insert', cells: {}, formatTemplateId: 'plain', createdOrder: 1 },
                { id: 'ins', origin: 'insert', cells: {}, formatTemplateId: 'plain', createdOrder: 2 },
            ],
        }],
        ['an inserted row the layout does not name', {
            rowLayout: { ...ROW_LAYOUT, runs: [{ kind: 'source', start: 0, count: 4 }] },
        }],
        ['an unknown row layout key', { rowLayout: { ...ROW_LAYOUT, extra: 1 } }],
        ['an unknown run key', {
            rowLayout: { ...ROW_LAYOUT, runs: [{ kind: 'source', start: 0, count: 4, note: 'x' }] },
        }],
        ['a non-canonical run split', {
            rowLayout: {
                ...ROW_LAYOUT,
                runs: [
                    { kind: 'source', start: 0, count: 1 },
                    { kind: 'pending', ids: ['ins'] },
                    { kind: 'source', start: 1, count: 1 },
                    { kind: 'source', start: 2, count: 2 },
                ],
            },
        }],
        ['a duplicate id in the row layout', {
            rowLayout: {
                ...ROW_LAYOUT,
                runs: [
                    { kind: 'pending', ids: ['ins'] },
                    { kind: 'source', start: 0, count: 2 },
                    { kind: 'pending', ids: ['ins'] },
                    { kind: 'source', start: 2, count: 2 },
                ],
            },
        }],
        ['a source row past the structural basis', {
            rowLayout: { ...ROW_LAYOUT, runs: [{ kind: 'pending', ids: ['ins'] }, { kind: 'source', start: 0, count: 5 }] },
        }],
        ['a removal outside the body', { rowLayout: { ...ROW_LAYOUT, removedSourceRows: [{ start: 3, count: 2 }] } }],
        ['a pending id that is too long', {
            rowLayout: { ...ROW_LAYOUT, discardedPendingRows: [{ id: 'x'.repeat(129), createdOrder: 9 }] },
        }],
        ['a column listed twice', {
            columnLayout: { ...COLUMN_LAYOUT, columns: [...COLUMN_LAYOUT.columns, { kind: 'source', sourceColumn: 0 }] },
        }],
        ['a column layout missing a source column', {
            columnLayout: { ...COLUMN_LAYOUT, columns: COLUMN_LAYOUT.columns.slice(0, 3) },
        }],
        ['an unknown column entry key', {
            columnLayout: { ...COLUMN_LAYOUT, columns: [{ kind: 'source', sourceColumn: 0, width: 3 }] },
        }],
        ['a Pending Column without a column layout', { columnLayout: undefined }],
        ['a duplicate Pending Column', { pendingColumns: [PENDING_COLUMN, PENDING_COLUMN] }],
        ['an unknown Pending Column key', { pendingColumns: [{ ...PENDING_COLUMN, color: 'red' }] }],
        ['a Pending Column cell with a bad row key', {
            pendingColumns: [{ ...PENDING_COLUMN, cells: { '3': { value: 'x' } } }],
        }],
        ['a Pending Column cell for an unknown pending row', {
            pendingColumns: [{ ...PENDING_COLUMN, cells: { 'p:nobody': { value: 'x' } } }],
        }],
        ['a Pending Column cell in a removed row', {
            pendingColumns: [{ ...PENDING_COLUMN, cells: { 's:2': { value: 'x' } } }],
        }],
        ['an invalid Pending Column format', {
            pendingColumns: [{ ...PENDING_COLUMN, format: { kind: 'source' } }],
        }],
        ['an unknown structural basis key', { structuralBasis: { ...BASIS, extra: true } }],
        ['a structural basis of the wrong kind', { structuralBasis: { ...BASIS, kind: 'xlsx' } }],
        ['a tail removal beside a live layout change', {
            tailRemovals: [{
                appendHistoryId: 'h',
                sourceRow: 3,
                savedFingerprint: 'fp',
                savedRow: { cells: {}, format: { kind: 'none' } },
            }],
        }],
        ['a pending cell move beside a live layout change', {
            appendedRows: [
                { id: 'app', cells: {}, formatTemplateId: 'plain', createdOrder: 1 },
                {
                    id: 'ins',
                    origin: 'insert',
                    cells: { 0: { value: 'y', movedFrom: { row: 0, col: 0, order: 3 } } },
                    formatTemplateId: 'plain',
                    createdOrder: 2,
                },
            ],
        }],
        ['a Pending Row cell in a removed column', {
            columnLayout: { ...COLUMN_LAYOUT, removedSourceColumns: [1] },
        }],
    ])('rejects %s', (_label, overrides) => {
        expect(() => owned(overrides)).toThrow(TypeError);
    });

    it('rejects a source cell edit in a removed row or column', () => {
        expect(() => own_pending_structural_changes({
            ...structural(),
            cells: { '2:0': { value: 'x', base: 'y' } },
        })).toThrow(TypeError);
        expect(() => own_pending_structural_changes({
            ...structural({ columnLayout: { ...COLUMN_LAYOUT, removedSourceColumns: [2] } }),
            cells: { '0:2': { value: 'x', base: 'y' } },
        })).toThrow(TypeError);
        expect(own_pending_structural_changes({
            ...structural(),
            cells: { '1:0': { value: 'x', base: 'y' } },
        }).rowLayout).toEqual(ROW_LAYOUT);
    });

    it('accepts a layout whose only change is discarded tombstones, with no basis', () => {
        const changes = own_pending_structural_changes({
            rowLayout: {
                runs: [{ kind: 'source', start: 0, count: 2 }, { kind: 'pending', ids: ['gone'] }],
                removedSourceRows: [],
                discardedPendingRows: [{ id: 'gone', createdOrder: 4 }],
            },
            tailRemovals: [{
                appendHistoryId: 'h',
                sourceRow: 1,
                savedFingerprint: 'fp',
                savedRow: { cells: {}, format: { kind: 'none' } },
            }],
        });
        expect(changes.rowLayout?.discardedPendingRows).toEqual([{ id: 'gone', createdOrder: 4 }]);
    });

    it('checks the full context at publication: Header Row, file size, and the ledger', () => {
        const changes = owned();
        const context = {
            bodyStart: 0,
            sourceRowCount: 4,
            sourceColumnCount: 3,
            mintedAsInsert: () => true,
        };
        expect(pending_structure_error(changes, {}, context)).toBeUndefined();
        expect(pending_structure_error(changes, {}, { ...context, bodyStart: 1 })).toBeDefined();
        expect(pending_structure_error(changes, {}, { ...context, sourceRowCount: 5 })).toBeDefined();
        expect(pending_structure_error(changes, {}, { ...context, sourceColumnCount: 4 })).toBeDefined();
        const with_discard = owned({
            rowLayout: {
                ...ROW_LAYOUT,
                runs: [...ROW_LAYOUT.runs, { kind: 'pending', ids: ['gone'] }],
                discardedPendingRows: [{ id: 'gone', createdOrder: 9 }],
            },
        });
        expect(pending_structure_error(with_discard, {}, context)).toBeUndefined();
        expect(pending_structure_error(with_discard, {}, {
            ...context,
            mintedAsInsert: (id) => id !== 'gone',
        })).toMatch(/not minted as an inserted row/);
        // A fixed-row Pending Column cell must sit above the body: decode cannot
        // tell where the Header Row is, publication can.
        const fixed = owned({ pendingColumns: [{ ...PENDING_COLUMN, cells: { 'f:0': { value: 'h' } } }] });
        expect(pending_structure_error(fixed, {}, context)).toMatch(/fixed-row cell/);
    });
});

describe('durable version 2', () => {
    const slot = (overrides: Partial<WorksheetPendingEdits> = {}): WorksheetPendingEdits => ({
        sheetName: 'Sheet1',
        cells: { '0:0': { value: 'v', base: 'b' } },
        ...overrides,
    });
    const versions = (state: PerFileState) =>
        (JSON.parse(stringify_stored_per_file_state(state)) as { pendingEdits?: { version: number } })
            .pendingEdits?.version;
    const changes = owned();

    it.each<[string, Partial<WorksheetPendingEdits> | undefined, 1 | 2]>([
        ['cell edits only', {}, 1],
        ['appended rows only', {
            formatTemplates: [TEMPLATE],
            appendedRows: [{ id: 'a', cells: {}, formatTemplateId: 'plain', createdOrder: 1 }],
        }, 1],
        ['a row layout', { rowLayout: { runs: [{ kind: 'source', start: 0, count: 2 }], removedSourceRows: [{ start: 1, count: 1 }], discardedPendingRows: [] } }, 2],
        ['a column layout', { columnLayout: COLUMN_LAYOUT }, 2],
        ['a Pending Column', { pendingColumns: [PENDING_COLUMN] }, 2],
        ['a structural basis', { structuralBasis: BASIS }, 2],
        ['an inserted row', {
            formatTemplates: [TEMPLATE],
            appendedRows: [{ id: 'i', origin: 'insert', cells: {}, formatTemplateId: 'plain', createdOrder: 1 }],
        }, 2],
    ])('writes the envelope version for %s', (_label, overrides, expected) => {
        const state: PerFileState = { pendingEdits: [slot(overrides)] };
        expect(versions(state)).toBe(expected);
        expect(stored_pending_edits_version(state)).toBe(expected);
    });

    it('writes version 2 for a stored rekey intent, with or without slots', () => {
        expect(versions({ pendingEdits: [slot()], structuralRekeyIntent: INTENT })).toBe(2);
        const json = JSON.parse(stringify_stored_per_file_state({ structuralRekeyIntent: INTENT }));
        expect(json).toEqual({ pendingEdits: { version: 2, sheets: [], rekeyIntent: INTENT } });
        expect(json.structuralRekeyIntent).toBeUndefined();
    });

    it('round-trips every new field through the durable codec', () => {
        const state: PerFileState = {
            pendingEdits: [undefined, {
                sheetName: 'Sheet2',
                cells: { '1:0': { value: 'v', base: 'b' } },
                formatTemplates: changes.formatTemplates,
                appendedRows: changes.appendedRows,
                rowLayout: changes.rowLayout,
                columnLayout: changes.columnLayout,
                pendingColumns: changes.pendingColumns,
                structuralBasis: changes.structuralBasis,
            }],
            structuralRekeyIntent: INTENT,
        };
        const stored = JSON.parse(stringify_stored_per_file_state(state));
        expect(stored.pendingEdits.version).toBe(2);
        const decoded = decode_stored_per_file_state(stored) as PerFileState;
        expect(decoded).toEqual(state);
        expect(stringify_stored_per_file_state(decoded)).toBe(stringify_stored_per_file_state(state));
    });

    it('decodes every legacy slot shape identically under both versions', () => {
        const legacy_slots = [
            [{ sheetName: 'S', cells: { '0:0': { value: 'x', base: '' } } }],
            [{ sheetName: 'S', worksheetId: '7', cells: {}, formatTemplates: [TEMPLATE], appendedRows: [{ id: 'a', cells: { 0: { value: 'v' } }, formatTemplateId: 'plain', createdOrder: 1 }], appendBasis: { sourceRowCount: 1, columnCount: 1, schemaFingerprint: 'fp' } }],
            [null, { sheetName: 'B', cells: { '2:1': 'plain-string' } }],
        ];
        for (const sheets of legacy_slots) {
            const v1 = decode_stored_per_file_state({ pendingEdits: { version: 1, sheets } });
            const v2 = decode_stored_per_file_state({ pendingEdits: { version: 2, sheets } });
            const unversioned = decode_stored_per_file_state({ pendingEdits: { sheets } });
            expect(v2).toEqual(v1);
            expect(unversioned).toEqual(v1);
        }
        expect(decode_stored_per_file_state({ pendingEdits: { '0:0': { value: 'x', base: '' } } }))
            .toEqual({ pendingEdits: [{ cells: { '0:0': { value: 'x', base: '' } } }] });
    });

    it('rejects a malformed rekey intent or one stored twice', () => {
        expect(() => decode_stored_per_file_state({
            pendingEdits: { version: 2, sheets: [], rekeyIntent: { ...INTENT, extra: 1 } },
        })).toThrow();
        expect(() => decode_stored_per_file_state({
            pendingEdits: { version: 2, sheets: [], rekeyIntent: { ...INTENT, worksheets: [] } },
        })).toThrow();
        expect(() => decode_stored_per_file_state({
            structuralRekeyIntent: INTENT,
            pendingEdits: { version: 2, sheets: [], rekeyIntent: INTENT },
        })).toThrow();
        expect(() => own_structural_rekey_intent({
            ...INTENT,
            receipt: { ...INTENT.receipt, appendedRows: [{ sheetIndex: 0, pendingRowId: '', sourceRow: 1, savedFingerprint: 'f' }] },
        })).toThrow();
        expect(own_structural_rekey_intent(INTENT)).toEqual(INTENT);
    });

    it('rejects a malformed layout inside a durable slot', () => {
        expect(() => decode_stored_per_file_state({
            pendingEdits: {
                version: 2,
                sheets: [{ cells: {}, rowLayout: { runs: [], removedSourceRows: [], discardedPendingRows: [], extra: 1 } }],
            },
        })).toThrow();
    });

    it('keeps the stored layout fields under a legacy cell-only publication', () => {
        const pending = [{
            sheetName: 'Sheet1',
            cells: {},
            formatTemplates: changes.formatTemplates,
            appendedRows: changes.appendedRows,
            rowLayout: changes.rowLayout,
            columnLayout: changes.columnLayout,
            pendingColumns: changes.pendingColumns,
            structuralBasis: changes.structuralBasis,
        }];
        const next = with_pending_edits_for_sheet(
            pending,
            0,
            { '1:0': { value: 'typed', base: 'b' } },
            'Sheet1',
        );
        expect(next?.[0]).toMatchObject({
            cells: { '1:0': { value: 'typed', base: 'b' } },
            rowLayout: changes.rowLayout,
            columnLayout: changes.columnLayout,
            pendingColumns: changes.pendingColumns,
            structuralBasis: changes.structuralBasis,
        });
    });
});

describe('own_wire_pending_changes layout fields', () => {
    const wire = (overrides: Record<string, unknown> = {}) => ({
        sheetIndex: 0,
        sheetName: 'Sheet1',
        cells: { '1:0': { value: 'v', base: 'b' } },
        ...structural(),
        ...overrides,
    });

    it('round-trips every new field', () => {
        const owned_wire = own_wire_pending_changes(wire());
        expect(owned_wire).toBeDefined();
        expect(owned_wire).toMatchObject({
            rowLayout: ROW_LAYOUT,
            columnLayout: COLUMN_LAYOUT,
            pendingColumns: [PENDING_COLUMN],
            structuralBasis: BASIS,
        });
        expect(own_wire_pending_changes(JSON.parse(JSON.stringify(owned_wire)))).toEqual(owned_wire);
    });

    it('still accepts the legacy wire shape', () => {
        expect(own_wire_pending_changes({
            sheetIndex: 0,
            cells: {},
            formatTemplates: [],
            appendedRows: [],
            tailRemovals: [],
            conflicts: [],
        })).toBeDefined();
    });

    it.each<[string, Record<string, unknown>]>([
        ['an unknown top-level key', { columnOrder: [] }],
        ['a forged origin', {
            appendedRows: [{ id: 'ins', origin: 'admin', cells: {}, formatTemplateId: 'plain', createdOrder: 2 }],
        }],
        ['a duplicate Pending Row id', {
            appendedRows: [
                { id: 'ins', origin: 'insert', cells: {}, formatTemplateId: 'plain', createdOrder: 1 },
                { id: 'ins', origin: 'insert', cells: {}, formatTemplateId: 'plain', createdOrder: 2 },
            ],
        }],
        ['a bad layout', { rowLayout: { runs: 'all' } }],
        ['a cell in a removed row', { cells: { '2:0': { value: 'v', base: 'b' } } }],
        ['layout state past the encoded-byte bound', {
            pendingColumns: [{ ...PENDING_COLUMN, header: 'x'.repeat(30_000), cells: Object.fromEntries(
                Array.from({ length: 400 }, (_, row) => [`f:${row}`, { value: 'y'.repeat(30_000) }]),
            ) }],
        }],
    ])('rejects %s', (_label, overrides) => {
        expect(own_wire_pending_changes(wire(overrides))).toBeUndefined();
    });
});

describe('raw appendedRows reads', () => {
    // `appendedRows` holds both Pending Row origins under its persisted name, so
    // a consumer must say which rows it means through `pending_rows`,
    // `appended_rows`, or `inserted_rows`. Only the codecs below may read the
    // stored array directly. `receipt.appendedRows` is a different field (the
    // save receipt's appended-row assignments) and is not affected.
    const ALLOWED: Record<string, readonly string[] | 'whole-file'> = {
        'src/pending-changes.ts': 'whole-file',
        'src/types.ts': [
            'rebase_pending_edit_orders',
            'decode_pending_edit_slots',
            'with_pending_edits_for_sheet',
            'own_wire_pending_changes',
        ],
        'src/history-replay-protocol.ts': ['sanitized_prepare_history_replay_request'],
        'src/webview/csv-save-lifecycle.ts': ['sanitized_structural_changes'],
        'src/webview/sheet-state.ts': ['normalize_pending_edits'],
    };
    const root = join(__dirname, '..', '..');

    function sources(directory: string): string[] {
        return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
            const path = join(directory, entry.name);
            if (entry.isDirectory()) {
                return entry.name === 'test' || entry.name === 'test-integration' ? [] : sources(path);
            }
            return /\.tsx?$/.test(entry.name) ? [path] : [];
        });
    }

    /** Character ranges of the named top-level functions' bodies. */
    function function_ranges(text: string, names: readonly string[]): [number, number][] {
        return names.map((name) => {
            const start = text.search(new RegExp(`function ${name}\\b`));
            if (start < 0) throw new Error(`Allowed function ${name} no longer exists.`);
            const open = text.indexOf('{', text.indexOf(')', start));
            let depth = 0;
            for (let index = open; index < text.length; index += 1) {
                if (text[index] === '{') depth += 1;
                if (text[index] === '}' && --depth === 0) return [start, index] as [number, number];
            }
            throw new Error(`Unbalanced function ${name}.`);
        });
    }

    it('happen only inside pending-changes.ts and the codecs', () => {
        const offenders: string[] = [];
        for (const file of sources(join(root, 'src'))) {
            const path = relative(root, file).split('\\').join('/');
            const allowed = ALLOWED[path];
            if (allowed === 'whole-file') continue;
            const text = readFileSync(file, 'utf8');
            const ranges = allowed === undefined ? [] : function_ranges(text, allowed);
            for (const match of text.matchAll(/([\w$\]).]*?)(\?)?\.appendedRows\b/g)) {
                if (/receipt$/i.test(match[1] ?? '')) continue;
                const at = match.index ?? 0;
                if (ranges.some(([start, end]) => at >= start && at <= end)) continue;
                const line = text.slice(0, at).split('\n').length;
                offenders.push(`${path}:${line}`);
            }
        }
        expect(offenders).toEqual([]);
    });
});
