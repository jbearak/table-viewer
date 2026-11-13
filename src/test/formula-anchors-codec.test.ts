// Formula Anchors in Pending Changes: the strict validator, the durable and
// wire codecs for cell entries, Pending Row cells, and Pending Column cells,
// the durable version-2 trigger, the refusal on CSV and TSV worksheets, and
// anchors replacing `formulaReferenceBases`.
import { describe, expect, it } from 'vitest';
import type { FormulaAnchors } from '../formula-anchors';
import {
    own_formula_anchors,
    own_pending_structural_changes,
    type PendingColumn,
    type StructuralBasis,
} from '../pending-changes';
import {
    copy_dirty_entry,
    decode_stored_per_file_state,
    is_strict_wire_dirty_entry,
    make_dirty_entry,
    own_wire_pending_changes,
    sanitized_wire_dirty_entry,
    stored_pending_edits_version,
    stringify_stored_per_file_state,
    type PerFileState,
    type WorksheetPendingEdits,
} from '../types';

/** `=A3+Sheet2!B$1:B2` with the first reference anchored to source row 2 and the range to a pending row. */
const TEXT = '=A3+Sheet2!B$1:B2';
const ANCHORS: FormulaAnchors = {
    references: [
        {
            start: 1,
            end: 3,
            corners: [{
                row: { kind: 'identity', row: { kind: 'source', sourceRow: 2 } },
                column: { kind: 'identity', column: { kind: 'source', sourceColumn: 0 } },
            }],
        },
        {
            start: 4,
            end: 17,
            worksheet: { sheetIndex: 1, sheetName: 'Sheet2' },
            corners: [
                {
                    row: { kind: 'fixed', row: 1 },
                    column: { kind: 'identity', column: { kind: 'pending', pendingColumnId: 'c1' } },
                },
                {
                    row: { kind: 'identity', row: { kind: 'pending', pendingRowId: 'p1' } },
                    column: { kind: 'trailing', offset: 2 },
                },
            ],
        },
    ],
};
const WHOLE_ROWS: FormulaAnchors = {
    references: [{ start: 1, end: 4, corners: [{ row: { kind: 'trailing', offset: 1 } }, { row: { kind: 'edge' } }] }],
};

const XLSX_TEMPLATE = {
    id: 'x',
    format: { kind: 'xlsx' as const, templateSourceRow: 1, styleFingerprint: 's', cellStyleIndexes: [] },
};
const PLAIN_TEMPLATE = { id: 'plain', format: { kind: 'none' as const } };
const DELIMITED_BASIS: StructuralBasis = {
    kind: 'delimited',
    byteLength: 10,
    digest: 'sha256:x',
    sourceRowCount: 4,
    sourceColumnCount: 3,
};

function with_change<T>(value: T, change: (copy: any) => void): unknown {
    const copy = structuredClone(value);
    change(copy);
    return copy;
}

describe('own_formula_anchors', () => {
    it('owns valid anchors exactly', () => {
        expect(own_formula_anchors(ANCHORS, TEXT)).toEqual(ANCHORS);
        expect(own_formula_anchors(WHOLE_ROWS, '=3:5')).toEqual(WHOLE_ROWS);
    });

    it.each<[string, unknown, string?]>([
        ['an empty reference list', { references: [] }],
        ['an extra field', with_change(ANCHORS, (copy) => { copy.extra = 1; })],
        ['an extra reference field', with_change(ANCHORS, (copy) => { copy.references[0].note = 'x'; })],
        ['a span past the text', with_change(ANCHORS, (copy) => { copy.references[1].end = 18; })],
        ['a span over the leading =', with_change(ANCHORS, (copy) => { copy.references[0].start = 0; })],
        ['an empty span', with_change(ANCHORS, (copy) => { copy.references[0].end = 1; })],
        ['overlapping spans', with_change(ANCHORS, (copy) => { copy.references[1].start = 2; })],
        ['spans out of order', with_change(ANCHORS, (copy) => { copy.references.reverse(); })],
        ['three corners', with_change(ANCHORS, (copy) => {
            copy.references[1].corners.push(copy.references[1].corners[0]);
        })],
        ['no corners', with_change(ANCHORS, (copy) => { copy.references[0].corners = []; })],
        ['an empty corner', with_change(ANCHORS, (copy) => { copy.references[0].corners = [{}]; })],
        ['corners naming different axes', with_change(ANCHORS, (copy) => {
            delete copy.references[1].corners[1].column;
        })],
        ['an unknown row anchor kind', with_change(ANCHORS, (copy) => {
            copy.references[0].corners[0].row = { kind: 'absolute', row: 3 };
        })],
        ['a fixed column anchor', with_change(ANCHORS, (copy) => {
            copy.references[0].corners[0].column = { kind: 'fixed', row: 1 };
        })],
        ['a zero trailing offset', with_change(ANCHORS, (copy) => {
            copy.references[1].corners[1].column = { kind: 'trailing', offset: 0 };
        })],
        ['a fixed row past the edge', with_change(ANCHORS, (copy) => {
            copy.references[1].corners[0].row = { kind: 'fixed', row: 1_048_577 };
        })],
        ['a negative source row', with_change(ANCHORS, (copy) => {
            copy.references[0].corners[0].row.row.sourceRow = -1;
        })],
        ['an empty pending row id', with_change(ANCHORS, (copy) => {
            copy.references[1].corners[1].row.row.pendingRowId = '';
        })],
        ['an identity with an extra field', with_change(ANCHORS, (copy) => {
            copy.references[0].corners[0].column.column.extra = true;
        })],
        ['a malformed worksheet target', with_change(ANCHORS, (copy) => {
            copy.references[1].worksheet = { sheetIndex: -1 };
        })],
        ['a worksheet target with an extra field', with_change(ANCHORS, (copy) => {
            copy.references[1].worksheet.path = 'x';
        })],
        ['anchors on text that is not a formula', ANCHORS, 'A3+Sheet2!B$1:B2'],
    ])('refuses %s', (_label, value, text = TEXT) => {
        expect(own_formula_anchors(value, text)).toBeUndefined();
    });
});

describe('cell entries', () => {
    const entry = { value: TEXT, base: '=A1', formulaAnchors: ANCHORS };

    it('carry anchors through the strict and sanitizing wire codecs and copies', () => {
        expect(is_strict_wire_dirty_entry(entry)).toBe(true);
        expect(sanitized_wire_dirty_entry(entry)).toEqual(entry);
        expect(copy_dirty_entry(entry)).toEqual(entry);
    });

    it('refuse anchors that do not fit the value, or beside reference bases', () => {
        const bases = [{
            targetSheetIndex: 0,
            targetSheetName: 'S',
            provisionalStartRow: 4,
            provisionalRowCount: 1,
        }];
        for (const bad of [
            { ...entry, value: '=A3' },
            { ...entry, formulaReferenceBases: bases },
            { ...entry, formulaAnchors: { references: [{ start: 1, end: 3 }] } },
        ]) {
            expect(is_strict_wire_dirty_entry(bad)).toBe(false);
            expect(sanitized_wire_dirty_entry(bad)).toBeUndefined();
        }
    });

    it('drop formula reference bases when anchors are stored', () => {
        const made = make_dirty_entry(TEXT, '=A1', undefined, undefined, undefined, undefined, {
            formulaReferenceBases: [{
                targetSheetIndex: 0,
                targetSheetName: 'S',
                provisionalStartRow: 4,
                provisionalRowCount: 1,
            }],
            formulaAnchors: ANCHORS,
        });
        expect(made).toEqual(entry);
    });
});

describe('durable codec', () => {
    const pending_column: PendingColumn = {
        id: 'c1',
        header: 'New',
        cells: { 's:2': { value: TEXT, formulaAnchors: ANCHORS } },
        format: { kind: 'default' },
        createdOrder: 0,
    };
    const slots: [string, WorksheetPendingEdits][] = [
        ['a cell entry', { sheetName: 'S', cells: { '2:1': { value: TEXT, base: '', formulaAnchors: ANCHORS } } }],
        ['a Pending Row cell', {
            sheetName: 'S',
            cells: {},
            formatTemplates: [XLSX_TEMPLATE],
            appendedRows: [{
                id: 'p1',
                cells: { 0: { value: TEXT, formulaAnchors: ANCHORS } },
                formatTemplateId: 'x',
                createdOrder: 0,
            }],
        }],
        ['a Pending Column cell', {
            sheetName: 'S',
            cells: {},
            columnLayout: {
                columns: [
                    { kind: 'source', sourceColumn: 0 },
                    { kind: 'pending', pendingColumnId: 'c1' },
                ],
                removedSourceColumns: [],
                discardedPendingColumns: [],
            },
            pendingColumns: [pending_column],
        }],
    ];

    it.each(slots)('writes version 2 and round-trips anchors on %s', (_label, slot) => {
        const state: PerFileState = { pendingEdits: [slot] };
        expect(stored_pending_edits_version(state)).toBe(2);
        const stored = JSON.parse(stringify_stored_per_file_state(state));
        expect(stored.pendingEdits.version).toBe(2);
        expect(decode_stored_per_file_state(stored)).toEqual(state);
    });

    it('keeps version 1 for formulas without anchors', () => {
        const state: PerFileState = {
            pendingEdits: [{
                sheetName: 'S',
                cells: { '2:1': { value: '=A3', base: '' } },
                formatTemplates: [XLSX_TEMPLATE],
                appendedRows: [{ id: 'p1', cells: { 0: { value: '=A1' } }, formatTemplateId: 'x', createdOrder: 0 }],
            }],
        };
        expect(stored_pending_edits_version(state)).toBe(1);
    });

    it('refuses a Pending Row cell whose anchors do not fit its value', () => {
        expect(() => own_pending_structural_changes({
            formatTemplates: [XLSX_TEMPLATE],
            appendedRows: [{
                id: 'p1',
                cells: { 0: { value: '=A3', formulaAnchors: ANCHORS } },
                formatTemplateId: 'x',
                createdOrder: 0,
            }],
        })).toThrow(/invalid formula anchors/);
    });

    it.each<[string, unknown]>([
        ['the pre-worksheet flat map', { '2:1': { value: TEXT, base: '', formulaAnchors: ANCHORS } }],
        ['a slot migrated from it', { version: 1, sheets: [
            { cells: { '2:1': { value: TEXT, base: '', formulaAnchors: ANCHORS } } },
        ] }],
        ['a slot with a delimited Structural Basis', { version: 2, sheets: [{
            sheetName: 'S',
            cells: { '2:1': { value: TEXT, base: '', formulaAnchors: ANCHORS } },
            rowLayout: {
                runs: [{ kind: 'source', start: 0, count: 4 }],
                removedSourceRows: [{ start: 3, count: 1 }],
                discardedPendingRows: [],
            },
            structuralBasis: DELIMITED_BASIS,
        }] }],
        ['a CSV Pending Row', { version: 2, sheets: [{
            sheetName: 'S',
            cells: {},
            formatTemplates: [PLAIN_TEMPLATE],
            appendedRows: [{
                id: 'p1',
                cells: { 0: { value: TEXT, formulaAnchors: ANCHORS } },
                formatTemplateId: 'plain',
                createdOrder: 0,
            }],
        }] }],
    ])('refuses anchors on CSV or TSV: %s', (_label, pendingEdits) => {
        expect(() => decode_stored_per_file_state({ pendingEdits })).toThrow();
        // The same values without anchors are ordinary CSV text.
        const without = JSON.parse(JSON.stringify(pendingEdits, (key, value) =>
            key === 'formulaAnchors' ? undefined : value));
        expect(() => decode_stored_per_file_state({ pendingEdits: without })).not.toThrow();
    });
});

describe('wire codec', () => {
    const snapshot = {
        sheetIndex: 0,
        sheetName: 'S',
        cells: { '2:1': { value: TEXT, base: '', formulaAnchors: ANCHORS } },
        formatTemplates: [],
        appendedRows: [],
        tailRemovals: [],
        conflicts: [],
    };

    it('owns anchors on an .xlsx worksheet', () => {
        expect(own_wire_pending_changes(snapshot)?.cells['2:1']).toEqual(snapshot.cells['2:1']);
        expect(own_wire_pending_changes(snapshot, { delimited: false })).toBeDefined();
    });

    it('refuses anchors on a CSV or TSV worksheet', () => {
        expect(own_wire_pending_changes(snapshot, { delimited: true })).toBeUndefined();
        expect(own_wire_pending_changes({
            ...snapshot,
            cells: {},
            formatTemplates: [PLAIN_TEMPLATE],
            appendedRows: [{
                id: 'p1',
                cells: { 0: { value: TEXT, formulaAnchors: ANCHORS } },
                formatTemplateId: 'plain',
                createdOrder: 0,
            }],
        })).toBeUndefined();
        // The same CSV value without anchors is ordinary text.
        expect(own_wire_pending_changes({
            ...snapshot,
            cells: { '2:1': { value: TEXT, base: '' } },
        }, { delimited: true })).toBeDefined();
    });

    it('refuses malformed anchors', () => {
        expect(own_wire_pending_changes({
            ...snapshot,
            cells: { '2:1': { value: TEXT, base: '', formulaAnchors: { references: [] } } },
        })).toBeUndefined();
    });
});

describe('cell history', () => {
    it('keeps anchors through the overlay state, the replay wire, and back', async () => {
        const { overlay_state_from_dirty_entry, dirty_entry_from_overlay_state } =
            await import('../webview/history-cell-state-model');
        const { wire_overlay_from_cell_overlay_state, cell_overlay_state_from_wire } =
            await import('../webview/history-replay-wire-model');
        const { sanitized_wire_cell_overlay_state } = await import('../history-replay-protocol');
        const entry = { value: TEXT, base: '=A1', formulaAnchors: ANCHORS };
        const state = overlay_state_from_dirty_entry(entry);
        expect(dirty_entry_from_overlay_state(state)).toEqual(entry);
        const wire = sanitized_wire_cell_overlay_state(
            JSON.parse(JSON.stringify(wire_overlay_from_cell_overlay_state(state))),
        );
        expect(wire).toBeDefined();
        expect(dirty_entry_from_overlay_state(cell_overlay_state_from_wire(wire!) as never)).toEqual(entry);
        // Anchors that do not fit the value do not cross the wire.
        const bad = JSON.parse(JSON.stringify(wire_overlay_from_cell_overlay_state(state)));
        bad.value.value.text = '=A3';
        expect(sanitized_wire_cell_overlay_state(bad)).toBeUndefined();
    });
});
