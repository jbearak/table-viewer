import { describe, expect, it } from 'vitest';
import { CompactSelection } from '@glideapps/glide-data-grid';
import {
    marker_drag_rows,
    marker_drag_state_for_selection,
} from '../webview/row-selection-model';

describe('marker_drag_rows', () => {
    it('unions the anchor→hover range onto the base rows', () => {
        const drag = { anchor: 2, base: CompactSelection.fromSingleSelection(2) };
        expect(marker_drag_rows(drag, 5, 10).toArray()).toEqual([2, 3, 4, 5]);
        expect(marker_drag_rows(drag, 0, 10).toArray()).toEqual([0, 1, 2]);
    });

    it('shrinking the sweep drops rows only covered by the wider sweep', () => {
        const drag = { anchor: 2, base: CompactSelection.fromSingleSelection(2) };
        marker_drag_rows(drag, 6, 10);
        expect(marker_drag_rows(drag, 3, 10).toArray()).toEqual([2, 3]);
    });

    it('keeps pre-existing cmd-click rows in the base selection', () => {
        const base = CompactSelection.fromSingleSelection(0).add(4);
        const drag = { anchor: 4, base };
        expect(marker_drag_rows(drag, 6, 10).toArray()).toEqual([0, 4, 5, 6]);
    });

    it('clamps the hovered row to the display range', () => {
        const drag = { anchor: 8, base: CompactSelection.fromSingleSelection(8) };
        expect(marker_drag_rows(drag, 42, 10).toArray()).toEqual([8, 9]);
        expect(marker_drag_rows(drag, -3, 10).toArray())
            .toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8]);
    });
});

describe('marker_drag_state_for_selection', () => {
    it('anchors on the newly added row after a plain click', () => {
        const state = marker_drag_state_for_selection(
            CompactSelection.empty(),
            CompactSelection.fromSingleSelection(3),
        );
        expect(state?.anchor).toBe(3);
    });

    it('anchors on the toggled-in row after a cmd/ctrl-click', () => {
        const previous = CompactSelection.fromSingleSelection(1);
        const next = previous.add(4);
        const state = marker_drag_state_for_selection(previous, next);
        expect(state?.anchor).toBe(4);
        expect(state?.base.toArray()).toEqual([1, 4]);
    });

    it('falls back to the sole selected row when a re-click adds nothing', () => {
        const only = CompactSelection.fromSingleSelection(2);
        expect(marker_drag_state_for_selection(only, only)?.anchor).toBe(2);
    });

    it('returns null when a shift-click adds a multi-row range', () => {
        const state = marker_drag_state_for_selection(
            CompactSelection.fromSingleSelection(1),
            CompactSelection.fromSingleSelection([1, 5]),
        );
        expect(state).toBeNull();
    });

    it('returns null when a cmd/ctrl-click toggles a row off', () => {
        const previous = CompactSelection.fromSingleSelection(1).add(4).add(7);
        const state = marker_drag_state_for_selection(previous, previous.remove(4));
        expect(state).toBeNull();
    });
});
