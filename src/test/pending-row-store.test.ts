import { describe, expect, it, vi } from 'vitest';
import {
    MAX_PENDING_APPENDED_ROWS,
    MAX_PENDING_CHANGES_ENCODED_BYTES,
    MAX_PENDING_USER_CHANGES_ENCODED_BYTES,
} from '../pending-changes';
import { create_pending_row_store } from '../webview/pending-row-store';

const plain_template = { id: 'plain', format: { kind: 'none' as const } };

describe('PendingRowStore', () => {
    it('persists a completely blank admitted row as structural state', () => {
        const store = create_pending_row_store({ session_id: 'session' });
        const listener = vi.fn();
        store.subscribe(listener);

        expect(store.append_rows('session', ['row-1'], plain_template, 4)).toBe(true);
        expect(store.snapshot()).toMatchObject({
            formatTemplates: [plain_template],
            appendedRows: [{ id: 'row-1', cells: {}, createdOrder: 4 }],
        });
        expect(listener).toHaveBeenCalledTimes(1);
    });

    it('fences stale writers at the session stamp', () => {
        const store = create_pending_row_store({ session_id: 'new' });
        expect(store.append_rows('old', ['row-1'], plain_template, 1)).toBe(false);
        expect(store.snapshot().appendedRows).toHaveLength(0);
    });

    it('edits cells by opaque row identity and drops no sibling row', () => {
        const store = create_pending_row_store({ session_id: 's' });
        store.append_rows('s', ['row-1', 'row-2'], plain_template, 1);
        expect(store.set_cell('s', 'row-2', 3, { value: 'x', valueEditOrder: 8 }))
            .toBe(true);
        expect(store.snapshot().appendedRows[0].cells).toEqual({});
        expect(store.snapshot().appendedRows[1].cells).toEqual({
            3: { value: 'x', valueEditOrder: 8 },
        });
    });

    it('retains untouched row objects during a batch cell edit', () => {
        const store = create_pending_row_store({ session_id: 's' });
        store.append_rows('s', ['row-1', 'row-2'], plain_template, 1);
        const untouched = store.snapshot().appendedRows[0];
        expect(store.set_cells('s', [{
            pendingRowId: 'row-2',
            sourceColumn: 0,
            cell: { value: 'changed', valueEditOrder: 3 },
        }])).toBe(true);
        expect(store.snapshot().appendedRows[0]).toBe(untouched);
    });

    it('does not reserialize 10,000 untouched rows for one cell edit', () => {
        const store = create_pending_row_store({ session_id: 's' });
        const ids = Array.from(
            { length: MAX_PENDING_APPENDED_ROWS },
            (_unused, index) => `row-${index}`,
        );
        expect(store.append_rows('s', ids, plain_template, 1)).toBe(true);
        const untouched = store.snapshot().appendedRows.at(-1)!;
        const stringify = vi.spyOn(JSON, 'stringify');
        try {
            expect(store.set_cell('s', 'row-0', 0, {
                value: 'changed',
                valueEditOrder: 2,
            })).toBe(true);
            expect(stringify.mock.calls.some(([value]) => value === untouched)).toBe(false);
            expect(stringify.mock.calls.some(
                ([value]) => value === store.snapshot().appendedRows,
            )).toBe(false);
        } finally {
            stringify.mockRestore();
        }
    });

    it('rejects a local edit that would exceed the aggregate payload bound', () => {
        const store = create_pending_row_store({ session_id: 's' });
        store.append_rows('s', ['row-1'], plain_template, 1);
        const before = store.snapshot();
        expect(store.set_cell('s', 'row-1', 0, { value: 'x'.repeat(8 * 1024 * 1024) }))
            .toBe(false);
        expect(store.snapshot()).toBe(before);
    });

    it('rejects an auto-grown height atomically with an oversized cell batch', () => {
        const store = create_pending_row_store({ session_id: 's' });
        store.append_rows('s', ['row-1'], plain_template, 1);
        const before = store.snapshot();
        expect(store.set_cells('s', [{
            pendingRowId: 'row-1',
            sourceColumn: 0,
            cell: { value: 'x'.repeat(8 * 1024 * 1024) },
        }], new Map([['row-1', 96]]))).toBe(false);
        expect(store.snapshot()).toBe(before);
        expect(store.snapshot().appendedRows[0].viewerRowHeight).toBeUndefined();
    });

    it('charges source edits and structural rows to one worksheet envelope', () => {
        const store = create_pending_row_store({ session_id: 's' });
        store.append_rows('s', ['row-1'], plain_template, 1);
        const refused = vi.fn();
        store.set_envelope_context(
            { sheetIndex: 0, sheetName: 'Data' },
            () => {
                const cells = {
                    '0:0': {
                        value: 'x'.repeat(MAX_PENDING_CHANGES_ENCODED_BYTES - 256),
                        base: '',
                    },
                };
                return {
                    cells,
                    encodedBytes: new TextEncoder().encode(JSON.stringify(cells)).byteLength,
                };
            },
            refused,
        );
        const before = store.snapshot();

        expect(store.set_cell('s', 'row-1', 0, { value: 'pending' })).toBe(false);
        expect(store.snapshot()).toBe(before);
        expect(refused).toHaveBeenCalledOnce();
    });

    it('removes rows atomically and restores their order and template', () => {
        const store = create_pending_row_store({ session_id: 's' });
        store.append_rows('s', ['row-1', 'row-2'], plain_template, 5);
        const removed = store.remove_rows('s', new Set(['row-1']));
        expect(removed?.map((row) => row.id)).toEqual(['row-1']);
        expect(store.snapshot().appendedRows.map((row) => row.id)).toEqual(['row-2']);
        expect(store.restore_rows('s', removed ?? [], [plain_template])).toBe(true);
        expect(store.snapshot().appendedRows.map((row) => row.id)).toEqual(['row-1', 'row-2']);
    });

    it('clears the append basis when the final pending row is removed', () => {
        const store = create_pending_row_store({ session_id: 's' });
        const basis = {
            sourceRowCount: 1,
            provisionalStartRow: 1,
            provisionalRowCount: 1,
            columnCount: 1,
            schemaFingerprint: 'schema',
        };
        expect(store.append_rows('s', ['row-1'], plain_template, 1, basis)).toBe(true);

        expect(store.remove_rows('s', new Set(['row-1']))?.map((row) => row.id))
            .toEqual(['row-1']);
        expect(store.snapshot().appendBasis).toBeUndefined();
    });

    it('allows a hard-bounded removal to shrink an envelope above the user cap', () => {
        const store = create_pending_row_store({ session_id: 's' });
        expect(store.append_rows('s', ['row-1'], plain_template, 1)).toBe(true);
        const cells = {
            '0:0': {
                value: 'x'.repeat(MAX_PENDING_USER_CHANGES_ENCODED_BYTES),
                base: '',
            },
        };
        const refused = vi.fn();
        store.set_envelope_context(
            { sheetIndex: 0, sheetName: 'Data' },
            () => ({
                cells,
                encodedBytes: new TextEncoder().encode(JSON.stringify(cells)).byteLength,
            }),
            refused,
        );

        expect(store.remove_rows('s', new Set(['row-1']))?.map((row) => row.id))
            .toEqual(['row-1']);
        expect(store.snapshot().appendedRows).toEqual([]);
        expect(refused).not.toHaveBeenCalled();
    });

    it('clears only rows and removals owned by one successful save receipt', () => {
        const store = create_pending_row_store({ session_id: 's' });
        store.append_rows('s', ['saved', 'later'], plain_template, 1);
        store.replace_tail_removals('s', [{
            appendHistoryId: 'history-1',
            sourceRow: 9,
            savedFingerprint: 'fingerprint',
            savedRow: { cells: {}, format: { kind: 'none' } },
        }]);
        store.clear_saved('s', new Set(['saved']), new Set([9]));
        expect(store.snapshot().appendedRows.map((row) => row.id)).toEqual(['later']);
        expect(store.snapshot().tailRemovals).toEqual([]);
    });

    it('clears only the conflict identities resolved by row removal actions', () => {
        const store = create_pending_row_store({ session_id: 's' });
        const first = {
            appendHistoryId: 'history-1',
            sourceRow: 8,
            savedFingerprint: 'fingerprint-1',
            savedRow: { cells: {}, format: { kind: 'none' as const } },
        };
        const second = {
            appendHistoryId: 'history-2',
            sourceRow: 9,
            savedFingerprint: 'fingerprint-2',
            savedRow: { cells: {}, format: { kind: 'none' as const } },
        };
        expect(store.install({ session_id: 's' }, {
            formatTemplates: [plain_template],
            appendedRows: [{
                id: 'pending-1',
                cells: {},
                formatTemplateId: plain_template.id,
                createdOrder: 1,
            }],
            tailRemovals: [first, second],
            conflicts: [{
                reason: 'savedSuffixChanged',
                pendingRowIds: ['pending-1'],
                tailRemovalIds: ['history-1', 'history-2'],
            }],
        })).toBe(true);
        expect(store.replace_tail_removals('s', [second])).toBe(true);
        expect(store.snapshot().conflicts[0]).toMatchObject({
            pendingRowIds: ['pending-1'],
            tailRemovalIds: ['history-2'],
        });
        store.remove_rows('s', new Set(['pending-1']));
        expect(store.snapshot().conflicts[0]).toMatchObject({
            pendingRowIds: [],
            tailRemovalIds: ['history-2'],
        });
        expect(store.replace_tail_removals('s', [])).toBe(true);
        expect(store.snapshot().conflicts).toEqual([]);
    });

    it('clears an ambiguous-formula conflict when the affected row is edited', () => {
        const store = create_pending_row_store({ session_id: 's' });
        expect(store.install({ session_id: 's' }, {
            formatTemplates: [plain_template],
            appendedRows: [{
                id: 'pending-1',
                cells: { 0: { value: '=A1' } },
                formatTemplateId: plain_template.id,
                createdOrder: 1,
            }],
            tailRemovals: [],
            conflicts: [
                {
                    reason: 'ambiguousPendingFormula',
                    pendingRowIds: ['pending-1'],
                    tailRemovalIds: [],
                    formulaCells: [{
                        rowIdentity: { kind: 'pending', pendingRowId: 'pending-1' },
                        sourceColumn: 0,
                    }],
                },
                {
                    reason: 'ambiguousColumns',
                    pendingRowIds: ['pending-1'],
                    tailRemovalIds: [],
                },
            ],
        })).toBe(true);
        expect(store.set_cell('s', 'pending-1', 1, { value: 'unrelated' })).toBe(true);
        expect(store.snapshot().conflicts).toHaveLength(2);
        expect(store.set_cell('s', 'pending-1', 0, { value: '=A2' })).toBe(true);
        expect(store.snapshot().conflicts).toEqual([{
            reason: 'ambiguousColumns',
            pendingRowIds: ['pending-1'],
            tailRemovalIds: [],
        }]);
    });

    it('edits a hyperlink without resolving formula conflicts or dropping provenance', () => {
        const formulaReferenceBases = [{
            targetSheetIndex: 0,
            targetSheetName: 'Data',
            provisionalStartRow: 10,
            provisionalRowCount: 1,
        }];
        const movedFrom = { row: 4, col: 2, order: 7 };
        const store = create_pending_row_store({ session_id: 's' });
        expect(store.install({ session_id: 's' }, {
            formatTemplates: [plain_template],
            appendedRows: [{
                id: 'pending-1',
                cells: {
                    0: {
                        value: '=A1',
                        formulaReferenceBases,
                        movedFrom,
                    },
                },
                formatTemplateId: plain_template.id,
                createdOrder: 1,
            }],
            tailRemovals: [],
            conflicts: [{
                reason: 'ambiguousPendingFormula',
                pendingRowIds: ['pending-1'],
                tailRemovalIds: [],
                formulaCells: [{
                    rowIdentity: { kind: 'pending', pendingRowId: 'pending-1' },
                    sourceColumn: 0,
                }],
            }],
        })).toBe(true);

        const link = { kind: 'external' as const, target: 'https://example.com/' };
        expect(store.set_hyperlink('s', 'pending-1', 0, link)).toBe(true);
        expect(store.snapshot().appendedRows[0].cells[0]).toEqual({
            value: '=A1',
            formulaReferenceBases,
            movedFrom,
            link,
        });
        expect(store.snapshot().conflicts).toEqual([{
            reason: 'ambiguousPendingFormula',
            pendingRowIds: ['pending-1'],
            tailRemovalIds: [],
            formulaCells: [{
                rowIdentity: { kind: 'pending', pendingRowId: 'pending-1' },
                sourceColumn: 0,
            }],
        }]);
        expect(store.set_hyperlink('stale', 'pending-1', 0, null)).toBe(false);
        expect(store.snapshot().appendedRows[0].cells[0]?.link).toEqual(link);
    });

    it('rejects malformed hydration atomically', () => {
        const store = create_pending_row_store({ session_id: 's' });
        store.append_rows('s', ['kept'], plain_template, 1);
        expect(store.install({ session_id: 'new' }, {
            formatTemplates: [plain_template],
            appendedRows: [{
                id: 'bad', cells: { 256: { value: 'x' } },
                formatTemplateId: 'plain', createdOrder: 2,
            }],
        })).toBe(false);
        expect(store.identity()?.session_id).toBe('s');
        expect(store.snapshot().appendedRows[0].id).toBe('kept');
    });
});
