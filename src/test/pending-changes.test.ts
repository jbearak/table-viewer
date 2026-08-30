import { describe, it, expect } from 'vitest';
import {
    plain_value,
    rich_value,
    editable_value_text,
    editable_values_equal,
    hyperlink_changes_equal,
    is_valid_rich_text,
    is_valid_editable_value,
    is_valid_hyperlink,
    is_valid_hyperlink_change,
    has_pending_structural_changes,
    MAX_PENDING_CHANGES_ENCODED_BYTES,
    MAX_PENDING_USER_CHANGES_ENCODED_BYTES,
    own_pending_structural_changes,
} from '../pending-changes';
import { own_wire_pending_changes } from '../types';
import type { RichText } from '../cell-content';

const STYLED: RichText = { runs: [{ text: 'a' }, { text: 'b', style: { bold: true } }] };
const UNSTYLED: RichText = { runs: [{ text: 'ab' }] };

describe('editable_value_text', () => {
    it('returns the plain text of either kind', () => {
        expect(editable_value_text(plain_value('x'))).toBe('x');
        expect(editable_value_text(rich_value(STYLED))).toBe('ab');
    });
});

describe('editable_values_equal', () => {
    it('compares plain to plain and rich to rich', () => {
        expect(editable_values_equal(plain_value('x'), plain_value('x'))).toBe(true);
        expect(editable_values_equal(plain_value('x'), plain_value('y'))).toBe(false);
        expect(editable_values_equal(rich_value(STYLED), rich_value(STYLED))).toBe(true);
        expect(editable_values_equal(rich_value(STYLED), rich_value(UNSTYLED))).toBe(false);
    });

    it('a styled rich value never equals a plain value with the same text', () => {
        expect(editable_values_equal(plain_value('ab'), rich_value(STYLED))).toBe(false);
        expect(editable_values_equal(rich_value(STYLED), plain_value('ab'))).toBe(false);
    });

    it('an unstyled rich value equals the same plain text', () => {
        expect(editable_values_equal(plain_value('ab'), rich_value(UNSTYLED))).toBe(true);
        expect(editable_values_equal(rich_value(UNSTYLED), plain_value('ab'))).toBe(true);
        expect(editable_values_equal(rich_value(UNSTYLED), plain_value('xy'))).toBe(false);
    });
});

describe('hyperlink_changes_equal', () => {
    const ext = { kind: 'external' as const, target: 'https://example.com/' };
    it('compares value and base on both sides, null meaning no link', () => {
        expect(hyperlink_changes_equal({ value: ext, base: null }, { value: { ...ext }, base: null })).toBe(true);
        expect(hyperlink_changes_equal({ value: ext, base: null }, { value: null, base: null })).toBe(false);
        expect(hyperlink_changes_equal({ value: null, base: ext }, { value: null, base: null })).toBe(false);
    });
});

describe('validators', () => {
    it('is_valid_rich_text accepts well-formed runs and rejects junk', () => {
        expect(is_valid_rich_text(STYLED)).toBe(true);
        expect(is_valid_rich_text({ runs: [] })).toBe(true);
        expect(is_valid_rich_text(null)).toBe(false);
        expect(is_valid_rich_text({ runs: 'x' })).toBe(false);
        expect(is_valid_rich_text({ runs: [{ text: 1 }] })).toBe(false);
        expect(is_valid_rich_text({ runs: [{ text: 'a', style: { bold: 'yes' } }] })).toBe(false);
        expect(is_valid_rich_text({ runs: [{ text: 'a', style: { color: true } }] })).toBe(false);
        const too_many = { runs: Array.from({ length: 4097 }, () => ({ text: 'x' })) };
        expect(is_valid_rich_text(too_many)).toBe(false);
    });

    it('is_valid_editable_value dispatches on kind', () => {
        expect(is_valid_editable_value(plain_value('x'))).toBe(true);
        expect(is_valid_editable_value(rich_value(STYLED))).toBe(true);
        expect(is_valid_editable_value({ kind: 'plain', text: 5 })).toBe(false);
        expect(is_valid_editable_value({ kind: 'richText', value: null })).toBe(false);
        expect(is_valid_editable_value({ kind: 'other' })).toBe(false);
    });

    it('is_valid_hyperlink enforces shape and length caps', () => {
        expect(is_valid_hyperlink({ kind: 'external', target: 'https://x.com' })).toBe(true);
        expect(is_valid_hyperlink({ kind: 'internal', location: 'Sheet1!A1', tooltip: 'hi' })).toBe(true);
        expect(is_valid_hyperlink({ kind: 'external', target: '' })).toBe(false);
        expect(is_valid_hyperlink({ kind: 'external', target: 'x'.repeat(8 * 1024 + 1) })).toBe(false);
        expect(is_valid_hyperlink({ kind: 'internal', location: 'x', tooltip: 42 })).toBe(false);
        expect(is_valid_hyperlink({ kind: 'mystery' })).toBe(false);
    });

    it('is_valid_hyperlink_change allows null on either side', () => {
        const ext = { kind: 'external', target: 'https://x.com/' };
        expect(is_valid_hyperlink_change({ value: ext, base: null })).toBe(true);
        expect(is_valid_hyperlink_change({ value: null, base: null })).toBe(true);
        expect(is_valid_hyperlink_change({ value: undefined, base: null })).toBe(false);
        expect(is_valid_hyperlink_change({ value: { kind: 'x' }, base: null })).toBe(false);
    });
});

describe('pending structural changes', () => {
    it('normalizes a legacy cell-only worksheet to empty structural state', () => {
        const owned = own_pending_structural_changes({});
        expect(owned).toEqual({
            formatTemplates: [],
            appendedRows: [],
            tailRemovals: [],
            conflicts: [],
        });
        expect(has_pending_structural_changes(owned)).toBe(false);
    });

    it('owns appended rows, interned XLSX formatting, and tail removals', () => {
        const owned = own_pending_structural_changes({
            formatTemplates: [{
                id: 'template-1',
                format: {
                    kind: 'xlsx',
                    templateSourceRow: 8,
                    styleFingerprint: 'styles:abc',
                    cellStyleIndexes: [1, null, 3],
                    nativeRowHeight: 18,
                    viewerRowHeight: 24,
                },
            }],
            appendedRows: [{
                id: 'row-1',
                cells: {
                    0: { value: 'new' },
                    2: {
                        value: 'linked',
                        link: { kind: 'external', target: 'https://example.com/' },
                        valueEditOrder: 7,
                    },
                },
                formatTemplateId: 'template-1',
                createdOrder: 6,
            }],
            tailRemovals: [{
                appendHistoryId: 'history-1',
                sourceRow: 9,
                savedFingerprint: 'row:def',
                savedRow: {
                    cells: { 0: { value: 'saved' } },
                    format: { kind: 'none' },
                },
            }],
        });

        expect(owned.appendedRows[0]).toMatchObject({
            id: 'row-1',
            cells: { 0: { value: 'new' } },
        });
        expect(owned.formatTemplates[0].format).toMatchObject({
            kind: 'xlsx',
            cellStyleIndexes: [1, null, 3],
        });
        expect(has_pending_structural_changes(owned)).toBe(true);
    });

    it('rejects identities, dangling templates, malformed cells, and oversized rows', () => {
        const template = { id: 't', format: { kind: 'none' } };
        const row = {
            id: 'r', cells: {}, formatTemplateId: 't', createdOrder: 1,
        };
        for (const value of [
            { formatTemplates: [template, template], appendedRows: [row] },
            { formatTemplates: [], appendedRows: [row] },
            { formatTemplates: [template], appendedRows: [{ ...row, cells: { bad: { value: 'x' } } }] },
            { formatTemplates: [template], appendedRows: [{ ...row, cells: { 0: { value: 3 } } }] },
            { formatTemplates: [template], appendedRows: [row, { ...row, createdOrder: 2 }] },
            {
                formatTemplates: [template],
                appendedRows: [
                    { ...row, id: 'later', createdOrder: 2 },
                    { ...row, id: 'earlier', createdOrder: 1 },
                ],
            },
            { formatTemplates: [template], appendedRows: [{ ...row, unexpected: true }] },
            { formatTemplates: [template], appendedRows: [{ ...row, cells: { 256: { value: 'x' } } }] },
            { formatTemplates: [template], appendedRows: [] },
            {
                tailRemovals: [{
                    appendHistoryId: 'h',
                    sourceRow: -1,
                    savedFingerprint: 'x',
                    savedRow: { cells: {}, format: { kind: 'none' } },
                }],
            },
            {
                tailRemovals: [{
                    appendHistoryId: 'h', sourceRow: 1, savedFingerprint: 'x',
                }],
            },
        ]) {
            expect(() => own_pending_structural_changes(value)).toThrow(TypeError);
        }
    });

    it('rejects an aggregate worksheet payload beyond the durable byte bound', () => {
        expect(() => own_pending_structural_changes({
            formatTemplates: [{ id: 'plain', format: { kind: 'none' } }],
            appendedRows: [{
                id: 'large-row',
                cells: { 0: { value: 'x'.repeat(MAX_PENDING_CHANGES_ENCODED_BYTES) } },
                formatTemplateId: 'plain',
                createdOrder: 1,
            }],
        })).toThrow('encoded-byte safety bound');
    });

    it('reserves the final four KiB from renderer-owned wire payloads', () => {
        const leaf = {
            sheetIndex: 0,
            cells: { '0:0': { value: '', base: '' } },
            formatTemplates: [],
            appendedRows: [],
            tailRemovals: [],
            conflicts: [],
        };
        const base_bytes = Buffer.byteLength(JSON.stringify(leaf), 'utf8');
        leaf.cells['0:0'].value = 'x'.repeat(
            MAX_PENDING_USER_CHANGES_ENCODED_BYTES - base_bytes + 1,
        );
        const bytes = Buffer.byteLength(JSON.stringify(leaf), 'utf8');
        expect(bytes).toBeGreaterThan(MAX_PENDING_USER_CHANGES_ENCODED_BYTES);
        expect(bytes).toBeLessThanOrEqual(MAX_PENDING_CHANGES_ENCODED_BYTES);
        expect(own_wire_pending_changes(leaf)).toBeUndefined();
    });

    it('allows an authenticated conflict-shaped overlay to use the host reserve', () => {
        const leaf = {
            sheetIndex: 0,
            cells: { '0:0': { value: '', base: '' } },
            formatTemplates: [],
            appendedRows: [],
            tailRemovals: [],
            conflicts: [] as unknown[],
        };
        const base_bytes = Buffer.byteLength(JSON.stringify(leaf), 'utf8');
        leaf.cells['0:0'].value = 'x'.repeat(
            MAX_PENDING_USER_CHANGES_ENCODED_BYTES - base_bytes - 16,
        );
        leaf.conflicts = [{
            reason: 'ambiguousPendingFormula',
            pendingRowIds: [],
            tailRemovalIds: [],
            formulaCells: [{
                rowIdentity: { kind: 'source', sourceRow: 0 },
                sourceColumn: 0,
            }],
        }];
        const bytes = Buffer.byteLength(JSON.stringify(leaf), 'utf8');
        expect(bytes).toBeGreaterThan(MAX_PENDING_USER_CHANGES_ENCODED_BYTES);
        expect(bytes).toBeLessThanOrEqual(MAX_PENDING_CHANGES_ENCODED_BYTES);
        expect(own_wire_pending_changes(leaf)?.conflicts).toEqual(leaf.conflicts);
    });

    it('accepts more than ten thousand formula conflict cells within the byte bound', () => {
        const formulaCells = Array.from({ length: 10_001 }, (_, sourceRow) => ({
            rowIdentity: { kind: 'source' as const, sourceRow },
            sourceColumn: 0,
        }));
        const owned = own_pending_structural_changes({
            conflicts: [{
                reason: 'ambiguousPendingFormula',
                pendingRowIds: [],
                tailRemovalIds: [],
                formulaCells,
            }],
        });

        expect(owned.conflicts[0].formulaCells).toHaveLength(10_001);
    });
});
