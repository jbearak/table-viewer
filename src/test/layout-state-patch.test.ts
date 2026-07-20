import { describe, expect, it } from 'vitest';
import {
    apply_layout_state_patch,
    derive_layout_state_patch,
    layout_state_patch_is_empty,
} from '../layout-state-patch';
import type { PerFileState } from '../types';
import type { NormalizedPerFileState } from '../viewer-snapshot';

function normalized(
    overrides: Partial<NormalizedPerFileState> = {},
): NormalizedPerFileState {
    return {
        columnWidths: [],
        rowHeights: [],
        scrollPosition: [],
        activeSheetIndex: 0,
        tabOrientation: null,
        transforms: [],
        columnVisibility: [],
        ...overrides,
    };
}

describe('layout state patches', () => {
    it('derives only changed layout leaves in deterministic sheet and key order', () => {
        const basis = normalized({
            columnWidths: [{ 10: 110, 2: 102 }, { 0: 90 }],
            rowHeights: [{ 4: 24 }],
            scrollPosition: [{ top: 1, left: 2 }],
            pendingEdits: { '0:0': 'draft' },
            excelFirstRowHeaders: { Sheet1: 'on' },
        });
        const incoming = normalized({
            columnWidths: [{ 10: 210, 2: 102 }, { 0: 90, 3: 93 }],
            rowHeights: [{ 4: 24 }],
            scrollPosition: [{ top: 5, left: 6 }],
            activeSheetIndex: 1,
            tabOrientation: 'vertical',
            pendingEdits: { '0:0': 'stale' },
            excelFirstRowHeaders: { Sheet1: 'off' },
        });

        const patch = derive_layout_state_patch(basis, incoming);

        expect(patch).toEqual({
            columnWidths: [
                { sheetIndex: 0, entries: [{ key: 10, change: { type: 'set', value: 210 } }] },
                { sheetIndex: 1, entries: [{ key: 3, change: { type: 'set', value: 93 } }] },
            ],
            rowHeights: [],
            scrollPosition: [{
                sheetIndex: 0,
                change: { type: 'set', value: { top: 5, left: 6 } },
            }],
            activeSheetIndex: { type: 'set', value: 1 },
            tabOrientation: { type: 'set', value: 'vertical' },
        });
        expect(Object.isFrozen(patch)).toBe(true);
        expect(Object.isFrozen(patch.columnWidths[0].entries[0])).toBe(true);
    });

    it('merges disjoint sheet and numeric-map changes into the latest durable state', () => {
        const basis = normalized({
            columnWidths: [{ 0: 100 }, { 0: 200 }],
            rowHeights: [{ 0: 20 }],
        });
        const incoming = normalized({
            columnWidths: [{ 0: 125 }, { 0: 200 }],
            rowHeights: [{ 0: 20, 2: 32 }],
        });
        const patch = derive_layout_state_patch(basis, incoming);
        const latest: PerFileState = {
            columnWidths: [{ 0: 100, 1: 150 }, { 0: 240 }],
            rowHeights: [{ 0: 20 }, { 1: 41 }],
            pendingEdits: { '0:0': 'peer' },
            excelFirstRowHeaders: { Sheet1: 'off' },
        };

        const merged = apply_layout_state_patch(latest, patch);

        expect(merged.columnWidths).toEqual([
            { 0: 125, 1: 150 },
            { 0: 240 },
        ]);
        expect(merged.rowHeights).toEqual([
            { 0: 20, 2: 32 },
            { 1: 41 },
        ]);
        expect(merged.pendingEdits).toEqual({ '0:0': 'peer' });
        expect(merged.excelFirstRowHeaders).toEqual({ Sheet1: 'off' });
    });

    it('deletes only basis-known keys and preserves concurrent additions', () => {
        const basis = normalized({
            columnWidths: [{ 0: 100, 1: 110 }],
            rowHeights: [{ 0: 20 }],
        });
        const incoming = normalized({
            columnWidths: [{ 1: 110 }],
            rowHeights: [],
        });
        const patch = derive_layout_state_patch(basis, incoming);
        const merged = apply_layout_state_patch({
            columnWidths: [{ 0: 100, 1: 110, 2: 120 }],
            rowHeights: [{ 0: 20, 1: 30 }],
        }, patch);

        expect(merged.columnWidths).toEqual([{ 1: 110, 2: 120 }]);
        expect(merged.rowHeights).toEqual([{ 1: 30 }]);
    });

    it('collapses emptied maps to undefined without truncating unrelated sheets', () => {
        const basis = normalized({ columnWidths: [{ 0: 100 }] });
        const incoming = normalized();
        const patch = derive_layout_state_patch(basis, incoming);
        const merged = apply_layout_state_patch({
            columnWidths: [{ 0: 100 }, { 0: 200 }],
        }, patch);

        expect(merged.columnWidths).toEqual([undefined, { 0: 200 }]);
    });

    it('treats scroll positions atomically per sheet and null orientation as a value', () => {
        const basis = normalized({
            scrollPosition: [{ top: 1, left: 2 }, { top: 3, left: 4 }],
            tabOrientation: 'horizontal',
        });
        const incoming = normalized({
            scrollPosition: [{ top: 10, left: 20 }],
            tabOrientation: null,
        });
        const patch = derive_layout_state_patch(basis, incoming);
        const merged = apply_layout_state_patch({
            scrollPosition: [
                { top: 1, left: 2 },
                { top: 30, left: 40 },
                { top: 50, left: 60 },
            ],
            tabOrientation: 'vertical',
        }, patch);

        expect(merged.scrollPosition).toEqual([
            { top: 10, left: 20 },
            undefined,
            { top: 50, left: 60 },
        ]);
        expect(merged.tabOrientation).toBeNull();
    });

    it('returns the current object for an empty or already-satisfied patch', () => {
        const state = normalized({ columnWidths: [{ 0: 100 }] });
        const empty = derive_layout_state_patch(state, state);
        expect(layout_state_patch_is_empty(empty)).toBe(true);
        expect(apply_layout_state_patch(state, empty)).toBe(state);

        const patch = derive_layout_state_patch(
            normalized(),
            normalized({ activeSheetIndex: 1 }),
        );
        const current = normalized({ activeSheetIndex: 1 });
        expect(apply_layout_state_patch(current, patch)).toBe(current);
    });
});
