import { describe, expect, it } from 'vitest';
import {
    apply_layout_state_patch,
    derive_layout_state_patch,
    layout_state_patch_is_empty,
} from '../layout-state-patch';
import { decode_stored_per_file_state, type PerFileState } from '../types';
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
    it('derives only changed layout leaves', () => {
        const basis = normalized({
            scrollPosition: [{ top: 1, left: 2 }, { top: 7, left: 8 }],
            pendingEdits: sheet_edits({ '0:0': 'draft' }),
            excelFirstRowHeaders: { Sheet1: 'on' },
        });
        const incoming = normalized({
            // Sheet 1's position is the same in both: a leaf that did not change
            // produces no entry at all.
            scrollPosition: [{ top: 5, left: 6 }, { top: 7, left: 8 }],
            activeSheetIndex: 1,
            tabOrientation: 'vertical',
            pendingEdits: sheet_edits({ '0:0': 'stale' }),
            excelFirstRowHeaders: { Sheet1: 'off' },
        });

        const patch = derive_layout_state_patch(basis, incoming);

        expect(patch).toEqual({
            scrollPosition: [{
                sheetIndex: 0,
                change: { type: 'set', value: { top: 5, left: 6 } },
            }],
            showFormatting: [],
            activeSheetIndex: { type: 'set', value: 1 },
            tabOrientation: { type: 'set', value: 'vertical' },
        });
        expect(Object.isFrozen(patch)).toBe(true);
        expect(Object.isFrozen(patch.scrollPosition[0])).toBe(true);
    });

    it('never patches column widths, whatever the panel copy holds', () => {
        // A width is written by `setColumnWidths`, which names its columns and is
        // answered. A `stateChanged` still carries the window's widths (the window
        // draws columns from them), and must not be able to write them: it is
        // refused whenever a delivery is in flight and has no answer for undo
        // history to record from.
        const basis = normalized({ columnWidths: [{ 0: 100, 1: 110 }, { 0: 200 }] });
        const incoming = normalized({ columnWidths: [{ 0: 125, 2: 32 }] });

        const patch = derive_layout_state_patch(basis, incoming);

        expect('columnWidths' in patch).toBe(false);
        expect(layout_state_patch_is_empty(patch)).toBe(true);
        const latest: PerFileState = { columnWidths: [{ 0: 100, 1: 150 }, { 0: 240 }] };
        expect(apply_layout_state_patch(latest, patch)).toBe(latest);
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

    it('merges a changed leaf into the latest durable state and leaves its peers alone', () => {
        const patch = derive_layout_state_patch(
            normalized({ scrollPosition: [{ top: 1, left: 2 }] }),
            normalized({ scrollPosition: [{ top: 9, left: 2 }] }),
        );
        const latest: PerFileState = {
            columnWidths: [{ 0: 100, 1: 150 }, { 0: 240 }],
            rowHeights: [{ 0: 20 }, { 1: 41 }],
            scrollPosition: [{ top: 1, left: 2 }, { top: 3, left: 4 }],
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

        // The sheet the panel never scrolled keeps its position.
        expect(merged.scrollPosition).toEqual([{ top: 9, left: 2 }, { top: 3, left: 4 }]);
        expect(merged.columnWidths).toBe(latest.columnWidths);
        expect(merged.rowHeights).toBe(latest.rowHeights);
        expect(sheet_cells(merged.pendingEdits)).toEqual({ '0:0': 'peer' });
        expect(merged.excelFirstRowHeaders).toEqual({ Sheet1: 'off' });
        expect(merged.cellHighlights).toBe(latest.cellHighlights);
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
        const state = normalized({ scrollPosition: [{ top: 1, left: 2 }] });
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

describe('sparse per-sheet state decoding', () => {
    it('restores JSON null gaps to undefined across every layout array', () => {
        // These arrays are written sparsely, but JSON has no holes, so every gap
        // comes back as `null`. Decoded state must restore the runtime spelling;
        // in particular, the row-height retention path calls Object.keys on maps.
        const decoded = decode_stored_per_file_state({
            columnWidths: [null, { 0: 120 }],
            rowHeights: [null, { 3: 44 }],
            scrollPosition: [null, { top: 10, left: 20 }],
            showFormatting: [null, false, true],
        }) as PerFileState;

        expect(decoded.columnWidths).toEqual([undefined, { 0: 120 }]);
        expect(decoded.rowHeights).toEqual([undefined, { 3: 44 }]);
        expect(decoded.scrollPosition).toEqual([undefined, { top: 10, left: 20 }]);
        expect(decoded.showFormatting).toEqual([undefined, false, true]);
    });

    it('rejects a non-boolean entry', () => {
        expect(() => decode_stored_per_file_state({ showFormatting: ['on'] })).toThrow();
        expect(() => decode_stored_per_file_state({ showFormatting: 5 })).toThrow();
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
     *   `setColumnVisibility`, `setColumnWidths`, `setRowHeights`, the highlight
     *   commands). Must *not* have a patch leaf, which is what stops a webview
     *   overwriting a map it cannot correctly key, or writing one with a message
     *   that has no answer.
     *
     * Adding a leaf to `PerFileState` without listing it here fails this test.
     */
    const PANEL_OWNED = [
        'scrollPosition',
        'activeSheetIndex',
        'tabOrientation',
        'showFormatting',
    ] as const;
    const HOST_OWNED = [
        'columnWidths',
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
        // A structural save's durable rekey intent: host bookkeeping between a
        // save's write and its post-write rekey.
        'structuralRekeyIntent',
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
            structuralRekeyIntent: {
                saveId: 'save',
                beforeDigest: 'before',
                afterDigest: 'after',
                worksheets: [{ sheetIndex: 0, acceptedSequence: 1 }],
                receipt: { appendedRows: [], removedSourceRows: [] },
            },
        };

        expect(Object.keys(populated).sort())
            .toEqual([...PANEL_OWNED, ...HOST_OWNED].sort());
    });

    it('gives every panel-owned leaf a patch leaf, and no host-owned one', () => {
        // Derived across a change in *every* panel-owned leaf, because the two
        // single-valued ones are omitted from the patch when unchanged — asked of an
        // empty derivation they would look unpatchable, and exempting them by name
        // would mean the guard never covered them at all.
        const patch = derive_layout_state_patch(
            normalized(),
            normalized({
                columnWidths: [{ 0: 90 }],
                scrollPosition: [{ top: 1, left: 2 }],
                activeSheetIndex: 1,
                tabOrientation: 'vertical',
                showFormatting: [false],
            }),
        );
        const patch_leaves = new Set(Object.keys(patch));

        for (const leaf of PANEL_OWNED) {
            expect(
                patch_leaves.has(leaf),
                `${leaf} is persisted but has no LayoutStatePatch leaf`,
            ).toBe(true);
        }
        for (const leaf of HOST_OWNED) {
            expect(patch_leaves.has(leaf), `${leaf} is host-owned but patchable`)
                .toBe(false);
        }
    });
});
