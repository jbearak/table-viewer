import { describe, it, expect } from 'vitest';
import {
    clamp_sheet_index,
    normalize_per_file_state,
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
});
