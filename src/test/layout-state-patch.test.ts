import { describe, expect, it } from 'vitest';
import {
    apply_layout_state_patch,
    derive_layout_state_patch,
    layout_state_patch_is_empty,
} from '../layout-state-patch';
import type { PerFileState } from '../types';
import type { NormalizedPerFileState } from '../viewer-snapshot';
import { sheet_cells, sheet_edits } from './pending-edits-helper';

function normalized(
    overrides: Partial<NormalizedPerFileState> = {},
): NormalizedPerFileState {
    return {
        columnWidths: [],
        scrollPosition: [],
        activeSheetIndex: 0,
        tabOrientation: null,
        transforms: [],
        columnVisibility: [],
        cellHighlights: undefined,
        ...overrides,
    };
}

describe('layout state patches', () => {
    it('derives only changed layout leaves in deterministic sheet and key order', () => {
        const basis = normalized({
            // Sheet 2's map is identical in both, which is the canary `rowHeights`
            // carried before the leaf was removed: a map that did not change must
            // produce no entry at all, not an empty one.
            columnWidths: [{ 10: 110, 2: 102 }, { 0: 90 }, { 4: 24 }],
            scrollPosition: [{ top: 1, left: 2 }],
            pendingEdits: sheet_edits({ '0:0': 'draft' }),
            excelFirstRowHeaders: { Sheet1: 'on' },
        });
        const incoming = normalized({
            columnWidths: [{ 10: 210, 2: 102 }, { 0: 90, 3: 93 }, { 4: 24 }],
            scrollPosition: [{ top: 5, left: 6 }],
            activeSheetIndex: 1,
            tabOrientation: 'vertical',
            pendingEdits: sheet_edits({ '0:0': 'stale' }),
            excelFirstRowHeaders: { Sheet1: 'off' },
        });

        const patch = derive_layout_state_patch(basis, incoming);

        expect(patch).toEqual({
            columnWidths: [
                { sheetIndex: 0, entries: [{ key: 10, change: { type: 'set', value: 210 } }] },
                { sheetIndex: 1, entries: [{ key: 3, change: { type: 'set', value: 93 } }] },
            ],
            scrollPosition: [{
                sheetIndex: 0,
                change: { type: 'set', value: { top: 5, left: 6 } },
            }],
            showFormatting: [],
            activeSheetIndex: { type: 'set', value: 1 },
            tabOrientation: { type: 'set', value: 'vertical' },
        });
        expect(Object.isFrozen(patch)).toBe(true);
        expect(Object.isFrozen(patch.columnWidths[0].entries[0])).toBe(true);
    });

    it('never patches row heights, however far the panel copy has drifted', () => {
        // Heights are host-owned: the only writer is `setRowHeights`, so a `stateChanged`
        // must not be able to touch them. The panel's copy is display-keyed and goes stale
        // the moment a sort installs, so a patch derived from it would delete the host's
        // source-keyed entries and write nonsense in their place. Asserted as "no leaf
        // exists" rather than "the leaf is empty", because an empty leaf is one refactor
        // away from a populated one.
        //
        // The maps are cast in past `NormalizedPerFileState`, which no longer *has* a
        // `rowHeights` field — the shape is `Omit`ted so the webview cannot be sent durable
        // heights at all. That makes the type the primary defence and this test the
        // secondary one: it proves the deriver ignores the property even when a caller
        // smuggles it in, which is the state a `stateChanged` message from an older webview
        // build would actually arrive in.
        const basis = normalized(
            { rowHeights: [{ 0: 20 }, { 5: 60 }] } as Partial<NormalizedPerFileState>,
        );
        const incoming = normalized(
            {
                rowHeights: [{ 0: 99 }, undefined, { 1: 44 }],
            } as Partial<NormalizedPerFileState>,
        );

        const patch = derive_layout_state_patch(basis, incoming);

        expect('rowHeights' in patch).toBe(false);
        expect(layout_state_patch_is_empty(patch)).toBe(true);
        const latest: PerFileState = { rowHeights: [{ 0: 20 }, { 5: 60 }] };
        expect(apply_layout_state_patch(latest, patch)).toBe(latest);
    });

    it('merges disjoint sheet and numeric-map changes into the latest durable state', () => {
        const basis = normalized({
            columnWidths: [{ 0: 100 }, { 0: 200 }],
        });
        const incoming = normalized({
            // Key 2 is a pure addition beside the change to key 0 — the other half of
            // what the removed `rowHeights` leaf used to cover here.
            columnWidths: [{ 0: 125, 2: 32 }, { 0: 200 }],
        });
        const patch = derive_layout_state_patch(basis, incoming);
        const latest: PerFileState = {
            columnWidths: [{ 0: 100, 1: 150 }, { 0: 240 }],
            rowHeights: [{ 0: 20 }, { 1: 41 }],
            pendingEdits: sheet_edits({ '0:0': 'peer' }),
            excelFirstRowHeaders: { Sheet1: 'off' },
            cellHighlights: {
                sourceDigest: 'latest-digest',
                sheets: [undefined, {
                    schema: 'dormant-schema',
                    cells: { '999:999': 'pink' },
                }],
            },
        };

        const merged = apply_layout_state_patch(latest, patch);

        expect(merged.columnWidths).toEqual([
            { 0: 125, 1: 150, 2: 32 },
            { 0: 240 },
        ]);
        // Untouched by the patch, and the trailing sheet the panel never saw survives.
        expect(merged.rowHeights).toBe(latest.rowHeights);
        expect(sheet_cells(merged.pendingEdits)).toEqual({ '0:0': 'peer' });
        expect(merged.excelFirstRowHeaders).toEqual({ Sheet1: 'off' });
        expect(merged.cellHighlights).toBe(latest.cellHighlights);
    });

    it('deletes only basis-known keys and preserves concurrent additions', () => {
        const basis = normalized({
            columnWidths: [{ 0: 100, 1: 110 }],
        });
        const incoming = normalized({
            columnWidths: [{ 1: 110 }],
        });
        const patch = derive_layout_state_patch(basis, incoming);
        // Row heights the panel would have deleted stand: same shape as the columnWidths
        // case below, and the whole point of the leaf being gone.
        const merged = apply_layout_state_patch({
            columnWidths: [{ 0: 100, 1: 110, 2: 120 }],
            rowHeights: [{ 0: 20, 1: 30 }],
        }, patch);

        expect(merged.columnWidths).toEqual([{ 1: 110, 2: 120 }]);
        expect(merged.rowHeights).toEqual([{ 0: 20, 1: 30 }]);
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

describe('showFormatting layout leaf', () => {
    it('derives and applies a per-sheet formatting change', () => {
        // A webview-owned view preference, like tabOrientation. Without a leaf here
        // the webview's `stateChanged` carried it and the host silently dropped it,
        // so the choice never survived a quit.
        const basis = normalized({ showFormatting: [] });
        const incoming = normalized({ showFormatting: [undefined, false] });

        const patch = derive_layout_state_patch(basis, incoming);
        expect(patch.showFormatting).toEqual([
            { sheetIndex: 1, change: { type: 'set', value: false } },
        ]);
        expect(layout_state_patch_is_empty(patch)).toBe(false);

        const applied = apply_layout_state_patch({ columnWidths: [] }, patch);
        expect(applied.showFormatting).toEqual([undefined, false]);
    });

    it('deletes a sheet slot that went back to the default', () => {
        const basis = normalized({ showFormatting: [false] });
        const incoming = normalized({ showFormatting: [] });

        const patch = derive_layout_state_patch(basis, incoming);
        expect(patch.showFormatting).toEqual([
            { sheetIndex: 0, change: { type: 'delete' } },
        ]);

        const applied = apply_layout_state_patch({ showFormatting: [false] }, patch);
        expect(applied.showFormatting).toEqual([undefined]);
    });

    it('leaves a peer panel\'s other sheets alone', () => {
        // The point of a patch rather than a whole-state write: two panels on the
        // same file must not clobber each other's sheets.
        const basis = normalized({ showFormatting: [true, true] });
        const incoming = normalized({ showFormatting: [true, false] });

        const patch = derive_layout_state_patch(basis, incoming);
        const applied = apply_layout_state_patch(
            { showFormatting: [false, true, false] },
            patch,
        );
        expect(applied.showFormatting).toEqual([false, false, false]);
    });

    it('reports an unchanged leaf as empty', () => {
        const basis = normalized({ showFormatting: [false, undefined] });
        const incoming = normalized({ showFormatting: [false, undefined] });

        expect(derive_layout_state_patch(basis, incoming).showFormatting).toEqual([]);
    });
});

describe('every persisted leaf is classified', () => {
    /**
     * `stateChanged` writes only what `LayoutStatePatch` names. A leaf the webview
     * persists but the patch omits is dropped by the host in silence — no error, no
     * warning, and the value simply never survives a quit. `showFormatting` shipped
     * that way and only surfaced when someone reopened the app.
     *
     * So every `PerFileState` leaf has to be one of two things, and this test is
     * where a new one is forced to say which:
     *
     * - **panel-owned** — written by the webview into `state_ref` and pushed with
     *   `persist_immediate()`. Must have a `LayoutStatePatch` leaf, or it is lost.
     * - **host-owned** — written by a dedicated message (`setTransform`,
     *   `setColumnVisibility`, `setRowHeights`, the highlight commands). Must *not*
     *   have a patch leaf, which is what stops a webview overwriting a map it cannot
     *   correctly key.
     *
     * Adding a leaf to `PerFileState` without listing it here fails this test.
     */
    const PANEL_OWNED = [
        'columnWidths',
        'scrollPosition',
        'activeSheetIndex',
        'tabOrientation',
        'showFormatting',
    ] as const;
    const HOST_OWNED = [
        'rowHeights',
        'transforms',
        'columnVisibility',
        'cellHighlights',
        'pendingEdits',
        'excelFirstRowHeaders',
        // A cache of the last effective projection, plus two one-time migration
        // markers. Host-computed bookkeeping, not preferences — a webview has no
        // business writing any of them.
        'excelFirstRowHeaderActive',
        'excelFirstRowHeaderVersion',
        'rowHeightsVersion',
    ] as const;

    it('classifies every leaf of a fully populated PerFileState', () => {
        const populated: Required<PerFileState> = {
            columnWidths: [],
            rowHeights: [],
            scrollPosition: [],
            activeSheetIndex: 0,
            tabOrientation: null,
            pendingEdits: sheet_edits({}),
            transforms: [],
            columnVisibility: [],
            cellHighlights: { sourceDigest: '', sheets: [] },
            showFormatting: [],
            excelFirstRowHeaders: {},
            excelFirstRowHeaderActive: {},
            excelFirstRowHeaderVersion: 1,
            rowHeightsVersion: 1,
        };

        expect(Object.keys(populated).sort())
            .toEqual([...PANEL_OWNED, ...HOST_OWNED].sort());
    });

    it('gives every panel-owned leaf a patch leaf, and no host-owned one', () => {
        const empty = derive_layout_state_patch(normalized(), normalized());
        const patch_leaves = new Set(Object.keys(empty));

        for (const leaf of PANEL_OWNED) {
            // activeSheetIndex and tabOrientation are single values, omitted from the
            // patch entirely when unchanged rather than carried as an empty array.
            const carried = patch_leaves.has(leaf)
                || leaf === 'activeSheetIndex'
                || leaf === 'tabOrientation';
            expect(carried, `${leaf} is persisted but has no LayoutStatePatch leaf`)
                .toBe(true);
        }
        for (const leaf of HOST_OWNED) {
            expect(patch_leaves.has(leaf), `${leaf} is host-owned but patchable`)
                .toBe(false);
        }
    });
});
