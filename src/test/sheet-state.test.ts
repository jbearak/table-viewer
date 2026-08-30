import { describe, it, expect } from 'vitest';
import {
    MAX_PERSISTED_HIDDEN_ROWS,
    clamp_sheet_index,
    normalize_per_file_state,
    sanitize_transform_state,
    trim_sheet_state_array,
} from '../webview/sheet-state';
import type { LegacyPerFileState, PerFileState } from '../types';
import { sheet_cells, sheet_edits } from './pending-edits-helper';

describe('sheet-state helpers', () => {
    it('clamps the active sheet index into range', () => {
        expect(clamp_sheet_index(undefined, 3)).toBe(0);
        expect(clamp_sheet_index(-1, 3)).toBe(0);
        expect(clamp_sheet_index(9, 3)).toBe(2);
    });

    it('normalizes legacy name-keyed state into index-keyed arrays', () => {
        const legacy_column_widths = Object.create(null) as Record<
            string,
            Record<number, number>
        >;
        legacy_column_widths.__proto__ = { 0: 140 };
        legacy_column_widths.Safe = { 0: 80 };

        const legacy_scroll_positions = Object.create(null) as Record<
            string,
            { top: number; left: number }
        >;
        legacy_scroll_positions.__proto__ = { top: 20, left: 10 };

        const legacy_state: LegacyPerFileState = {
            activeSheet: '__proto__',
            columnWidths: legacy_column_widths,
            scrollPosition: legacy_scroll_positions,
        };

        const normalized = normalize_per_file_state(legacy_state, [
            '__proto__',
            'Safe',
        ]);

        expect(normalized.activeSheetIndex).toBe(0);
        expect(normalized.columnWidths?.[0]).toEqual({ 0: 140 });
        expect(normalized.columnWidths?.[1]).toEqual({ 0: 80 });
        expect(normalized.scrollPosition?.[0]).toEqual({
            top: 20,
            left: 10,
        });
        expect(normalized.columnVisibility).toEqual([]);
    });

    it('preserves already-indexed state and trims removed sheets', () => {
        const indexed_state: PerFileState = {
            activeSheetIndex: 2,
            columnWidths: [{ 0: 120 }, undefined, { 1: 90 }],
            columnVisibility: [
                { hiddenColumns: [2, 0, 2, -1, 1.5], schema: 'first' },
                { hiddenColumns: [] },
                { hiddenColumns: [1], schema: 'removed' },
            ],
        };

        const normalized = normalize_per_file_state(indexed_state, [
            'First',
            'Second',
        ]);

        expect(normalized.activeSheetIndex).toBe(1);
        expect(normalized.columnWidths).toEqual([{ 0: 120 }, undefined]);
        expect(normalized.columnVisibility).toEqual([
            { hiddenColumns: [0, 2], schema: 'first' },
            undefined,
        ]);
    });

    it('preserves cell highlights through unrelated sheet-state normalization', () => {
        const cellHighlights = {
            sourceDigest: 'digest',
            sheets: [{ schema: 'schema', cells: { '2:1': 'yellow' as const } }],
        };
        const normalized = normalize_per_file_state({
            rowHeights: [{ 0: 42 }],
            cellHighlights,
        }, ['Sheet1']);
        expect(normalized.cellHighlights).toBe(cellHighlights);
        expect(normalized.rowHeights).toEqual([{ 0: 42 }]);
    });

    it('trims index-keyed arrays without re-keying by sheet name', () => {
        expect(
            trim_sheet_state_array([{ 0: 100 }, undefined, { 1: 80 }], 2)
        ).toEqual([{ 0: 100 }, undefined]);
    });

    it('drops malformed pending-edit keys, keeping well-formed row:col entries', () => {
        // A corrupt/old-format persisted key (not exactly two integers) would
        // parse to NaN coordinates downstream, leaving a phantom dirty entry
        // that can never be flagged conflicted or resolved. Reject it here.
        const state: PerFileState = {
            activeSheetIndex: 0,
            pendingEdits: sheet_edits({
                '1:2': 'good',
                '0:0': { value: 'v', base: 'b' },
                'bad-key': 'x',
                '1:2:3': 'y',
                '5:': 'z',
                ':5': 'w',
                '': 'empty',
            }) as PerFileState['pendingEdits'],
        };

        const normalized = normalize_per_file_state(state, ['Sheet1']);

        expect(sheet_cells(normalized.pendingEdits)).toEqual({
            '1:2': 'good',
            '0:0': { value: 'v', base: 'b' },
        });
    });

    it('preserves a persisted entry\u2019s runs and hyperlink through normalization', () => {
        // Normalization used to rebuild every entry as `{value, base}`, which
        // silently dropped the other dimensions: a pending formatting or
        // hyperlink edit vanished on the next restore.
        const link = { kind: 'external' as const, target: 'https://a.test/' };
        const runs = { runs: [{ text: 'v', style: { bold: true as const } }] };
        const state: PerFileState = {
            activeSheetIndex: 0,
            pendingEdits: sheet_edits({
                '0:0': { value: 'v', base: 'b', valueRuns: runs },
                '0:1': { value: 'x', base: 'x', link, baseLink: null },
            }) as PerFileState['pendingEdits'],
        };

        const normalized = normalize_per_file_state(state, ['Sheet1']);

        expect(sheet_cells(normalized.pendingEdits)).toEqual({
            '0:0': { value: 'v', base: 'b', valueRuns: runs },
            '0:1': { value: 'x', base: 'x', link, baseLink: null },
        });
    });

    it('preserves a structural-only pending-changes slot through normalization', () => {
        const pendingEdits: NonNullable<PerFileState['pendingEdits']> = [{
            sheetName: 'Sheet1',
            cells: {},
            formatTemplates: [{ id: 'plain', format: { kind: 'none' } }],
            appendedRows: [{
                id: 'pending-row',
                cells: { 0: { value: 'draft' } },
                formatTemplateId: 'plain',
                createdOrder: 1,
            }],
            appendBasis: {
                sourceRowCount: 1,
                provisionalStartRow: 1,
                columnCount: 1,
                schemaFingerprint: '["Sheet1",1,null]',
            },
        }];

        const normalized = normalize_per_file_state(
            { activeSheetIndex: 0, pendingEdits },
            ['Sheet1'],
        );

        expect(normalized.pendingEdits?.[0]).toMatchObject({
            sheetName: 'Sheet1',
            cells: {},
            appendedRows: [{ id: 'pending-row', cells: { 0: { value: 'draft' } } }],
            appendBasis: { provisionalStartRow: 1 },
        });
    });

    it('drops a persisted entry that is not a well-formed value/base record', () => {
        const state: PerFileState = {
            activeSheetIndex: 0,
            // Deliberately ill-typed: these are the shapes a corrupt or
            // tampered stored state can present, which is what this normalizer
            // exists to reject.
            pendingEdits: sheet_edits({
                '0:0': { value: 'v' },
                '0:1': { value: 1, base: 'b' },
                '0:2': null,
                '0:3': { value: 'keep', base: 'b' },
            } as never) as PerFileState['pendingEdits'],
        };

        const normalized = normalize_per_file_state(state, ['Sheet1']);

        expect(sheet_cells(normalized.pendingEdits)).toEqual({
            '0:3': { value: 'keep', base: 'b' },
        });
    });

    it('sanitizes persisted transforms and drops duplicate or out-of-range columns', () => {
        const sanitized = sanitize_transform_state({
            sort: [
                { colIndex: 1, direction: 'desc' },
                { colIndex: 1, direction: 'asc' },
                { colIndex: 9, direction: 'asc' },
            ],
            filters: [
                {
                    id: 'ok',
                    colIndex: 0,
                    operator: 'between',
                    value: '1',
                    secondValue: '2',
                    caseSensitive: false,
                    enabled: true,
                },
                {
                    id: 'duplicate-column',
                    colIndex: 0,
                    operator: 'contains',
                    value: 'x',
                    caseSensitive: false,
                    enabled: true,
                },
                {
                    id: 'ok',
                    colIndex: 1,
                    operator: 'contains',
                    value: 'duplicate id',
                    caseSensitive: false,
                    enabled: true,
                },
                {
                    id: 'missing-upper',
                    colIndex: 1,
                    operator: 'between',
                    value: '1',
                    caseSensitive: false,
                    enabled: true,
                },
            ],
        }, 2);

        expect(sanitized).toEqual({
            sort: [{ colIndex: 1, direction: 'desc' }],
            filters: [{
                id: 'ok',
                colIndex: 0,
                operator: 'between',
                value: '1',
                secondValue: '2',
                caseSensitive: false,
                enabled: true,
            }],
        });
    });

    it('sanitizes isOneOf exclusion lists and rejects malformed ones', () => {
        const entry = (overrides: Record<string, unknown>) => ({
            id: 'list',
            colIndex: 0,
            operator: 'isOneOf',
            caseSensitive: false,
            enabled: true,
            ...overrides,
        });

        // Valid: strings and null kept, non-strings dropped, duplicates
        // removed, caseSensitive forced false, scalar operands not retained.
        expect(sanitize_transform_state({
            sort: [],
            filters: [entry({
                excludedValues: ['a', null, 'a', 7, {}, 'b'],
                value: 'stale',
                secondValue: 'stale',
                caseSensitive: true,
            })],
        }, 1)).toEqual({
            sort: [],
            filters: [{
                id: 'list',
                colIndex: 0,
                operator: 'isOneOf',
                value: undefined,
                secondValue: undefined,
                excludedValues: ['a', null, 'b'],
                caseSensitive: false,
                enabled: true,
            }],
        });

        // Missing or non-array exclusion lists reject the entry outright.
        expect(sanitize_transform_state({
            sort: [],
            filters: [entry({})],
        }, 1)).toBeUndefined();
        expect(sanitize_transform_state({
            sort: [],
            filters: [entry({ excludedValues: 'a,b' })],
        }, 1)).toBeUndefined();

        // A non-empty list whose entries are all garbage is corrupt state, not
        // an "exclude nothing" filter — reject rather than match everything.
        expect(sanitize_transform_state({
            sort: [],
            filters: [entry({ excludedValues: [7, {}, undefined] })],
        }, 1)).toBeUndefined();

        // An empty list is valid (explicit include-everything filter).
        expect(sanitize_transform_state({
            sort: [],
            filters: [entry({ excludedValues: [] })],
        }, 1)?.filters[0].excludedValues).toEqual([]);

        // Other operators never retain an exclusion list.
        expect(sanitize_transform_state({
            sort: [],
            filters: [{
                id: 'text',
                colIndex: 0,
                operator: 'contains',
                value: 'x',
                excludedValues: ['a'],
                caseSensitive: false,
                enabled: true,
            }],
        }, 1)?.filters[0].excludedValues).toBeUndefined();
    });

    it('drops a persisted transform when its sheet schema fingerprint changes', () => {
        expect(sanitize_transform_state({
            sort: [{ colIndex: 0, direction: 'asc' }],
            filters: [],
            schema: 'old-schema',
        }, 1, 'new-schema')).toBeUndefined();
    });

    it('sanitizes hidden canonical rows and retains hidden-only descriptors', () => {
        expect(sanitize_transform_state({
            sort: [],
            filters: [],
            hiddenRows: [4, 2, 4, -1, 1.5, 8, '3'],
        }, 1, undefined, 6)).toEqual({
            sort: [],
            filters: [],
            hiddenRows: [2, 4],
        });
        expect(sanitize_transform_state({
            sort: [],
            filters: [],
            hiddenRows: 'corrupt',
        }, 1, undefined, 6)).toBeUndefined();
        expect(sanitize_transform_state({
            sort: [],
            filters: [],
        }, 1, undefined, 6)).toBeUndefined();
    });

    it('sanitizes the maximum hidden-row set without spreading it as arguments', () => {
        const hiddenRows = Array.from(
            { length: MAX_PERSISTED_HIDDEN_ROWS },
            (_, index) => index,
        );
        [hiddenRows[0], hiddenRows[1]] = [hiddenRows[1], hiddenRows[0]];

        const sanitized = sanitize_transform_state({
            sort: [],
            filters: [],
            hiddenRows,
        }, 1, undefined, MAX_PERSISTED_HIDDEN_ROWS);

        expect(sanitized?.hiddenRows).toHaveLength(MAX_PERSISTED_HIDDEN_ROWS);
        expect(sanitized?.hiddenRows?.[0]).toBe(0);
        expect(sanitized?.hiddenRows?.at(-1)).toBe(MAX_PERSISTED_HIDDEN_ROWS - 1);
    });

    it('preserves canonical hidden rows when a stale schema drops column transforms', () => {
        expect(sanitize_transform_state({
            sort: [{ colIndex: 0, direction: 'asc' }],
            filters: [],
            hiddenRows: [3, 1, 3],
            schema: '["People",1,["Old"]]',
        }, 1, '["People",1,["New"]]', 5)).toEqual({
            sort: [],
            filters: [],
            hiddenRows: [1, 3],
            schema: '["People",1,["New"]]',
        });
    });

});
