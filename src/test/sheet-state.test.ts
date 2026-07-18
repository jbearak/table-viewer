import { describe, it, expect } from 'vitest';
import {
    clamp_sheet_index,
    normalize_per_file_state,
    sanitize_transform_state,
    trim_sheet_state_array,
} from '../webview/sheet-state';
import type { LegacyPerFileState, PerFileState } from '../types';

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
    });

    it('preserves already-indexed state and trims removed sheets', () => {
        const indexed_state: PerFileState = {
            activeSheetIndex: 2,
            columnWidths: [{ 0: 120 }, undefined, { 1: 90 }],
        };

        const normalized = normalize_per_file_state(indexed_state, [
            'First',
            'Second',
        ]);

        expect(normalized.activeSheetIndex).toBe(1);
        expect(normalized.columnWidths).toEqual([{ 0: 120 }, undefined]);
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
            pendingEdits: {
                '1:2': 'good',
                '0:0': { value: 'v', base: 'b' },
                'bad-key': 'x',
                '1:2:3': 'y',
                '5:': 'z',
                ':5': 'w',
                '': 'empty',
            } as PerFileState['pendingEdits'],
        };

        const normalized = normalize_per_file_state(state, ['Sheet1']);

        expect(normalized.pendingEdits).toEqual({
            '1:2': 'good',
            '0:0': { value: 'v', base: 'b' },
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

    it('drops a persisted transform when its sheet schema fingerprint changes', () => {
        expect(sanitize_transform_state({
            sort: [{ colIndex: 0, direction: 'asc' }],
            filters: [],
            schema: 'old-schema',
        }, 1, 'new-schema')).toBeUndefined();
    });
});
