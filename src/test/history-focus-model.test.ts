import { describe, expect, it } from 'vitest';
import { create_column_projection } from '../webview/column-projection';
import {
    HISTORY_FLASH_DURATION_MS,
    begin_history_flash,
    history_flash_covers,
    history_flash_damage,
    history_focus_request,
    resolve_history_focus,
    type HistoryFocusView,
    type PendingHistoryFocus,
} from '../webview/history-focus-model';

function request(overrides: Partial<PendingHistoryFocus> = {}): PendingHistoryFocus {
    return {
        sequence: 1,
        direction: 'undo',
        sheetIndex: 0,
        displayRowStart: 2,
        displayRowEnd: 4,
        sourceColumnStart: 1,
        sourceColumnEnd: 2,
        mappingGeneration: 3,
        ...overrides,
    };
}

function view(overrides: Partial<HistoryFocusView> = {}): HistoryFocusView {
    return {
        rowCount: 100,
        mappingGeneration: 3,
        columnProjection: create_column_projection(5),
        ...overrides,
    };
}

describe('resolve_history_focus', () => {
    it('selects the replayed rectangle, anchored top-left', () => {
        expect(resolve_history_focus(request(), view())).toEqual({
            kind: 'applied',
            cell: [1, 2],
            range: { x: 1, y: 2, width: 2, height: 3 },
        });
    });

    it('projects source columns into visible space', () => {
        // Column 0 hidden, so source columns 1-2 are display columns 0-1. The host
        // never sees column visibility, which is why the request carries source
        // columns and this does the projecting.
        const projection = create_column_projection(5, { hiddenColumns: [0], schema: undefined });
        const outcome = resolve_history_focus(request(), view({ columnProjection: projection }));
        expect(outcome).toEqual({
            kind: 'applied',
            cell: [0, 2],
            range: { x: 0, y: 2, width: 2, height: 3 },
        });
    });

    it('narrows to the visible columns of a partly hidden span', () => {
        const projection = create_column_projection(5, { hiddenColumns: [1] });
        const outcome = resolve_history_focus(request(), view({ columnProjection: projection }));
        expect(outcome).toEqual({
            kind: 'applied',
            cell: [1, 2],
            range: { x: 1, y: 2, width: 1, height: 3 },
        });
    });

    it('refuses to substitute a visible column for a hidden one', () => {
        // Moving the cursor to a cell the replay did not touch would be read as
        // "this is what changed", which is worse than not moving it at all.
        const projection = create_column_projection(5, { hiddenColumns: [1, 2] });
        expect(resolve_history_focus(request(), view({ columnProjection: projection })))
            .toEqual({ kind: 'columns-hidden' });
    });

    it('declines when the mapping moved out from under the host projection', () => {
        expect(resolve_history_focus(request(), view({ mappingGeneration: 4 })))
            .toEqual({ kind: 'stale-mapping' });
    });

    it('clamps rows to what the grid will actually index', () => {
        const outcome = resolve_history_focus(
            request({ displayRowStart: 8, displayRowEnd: 40 }),
            view({ rowCount: 10 }),
        );
        expect(outcome).toEqual({
            kind: 'applied',
            cell: [1, 8],
            range: { x: 1, y: 8, width: 2, height: 2 },
        });
    });

    it('reports an empty grid rather than selecting into one', () => {
        expect(resolve_history_focus(request(), view({ rowCount: 0 })))
            .toEqual({ kind: 'empty-grid' });
        // No visible column at all, which the projection is the only witness to:
        // the column count is derived from it rather than passed alongside it.
        expect(resolve_history_focus(request(), view({
            columnProjection: create_column_projection(0),
        }))).toEqual({ kind: 'empty-grid' });
    });
});

describe('the history flash', () => {
    const range = { x: 1, y: 2, width: 2, height: 2 };

    it('covers its own rectangle until the deadline, and nothing after', () => {
        const flash = begin_history_flash(range, 1_000);
        expect(flash.expiresAt).toBe(1_000 + HISTORY_FLASH_DURATION_MS);
        expect(history_flash_covers(flash, 1, 2, 1_000)).toBe(true);
        expect(history_flash_covers(flash, 2, 3, flash.expiresAt - 1)).toBe(true);
        // At the deadline, not one tick after: the boundary is where the tint stops.
        expect(history_flash_covers(flash, 1, 2, flash.expiresAt)).toBe(false);
    });

    it('covers nothing outside the rectangle, and nothing when absent', () => {
        const flash = begin_history_flash(range, 0);
        expect(history_flash_covers(flash, 0, 2, 0)).toBe(false);
        expect(history_flash_covers(flash, 3, 2, 0)).toBe(false);
        expect(history_flash_covers(flash, 1, 4, 0)).toBe(false);
        expect(history_flash_covers(null, 1, 2, 0)).toBe(false);
    });

    it('damages only the visible intersection', () => {
        // A replay can span far more than the screen. Repainting off-screen cells
        // costs exactly as much as repainting visible ones and shows the user
        // nothing.
        const flash = begin_history_flash({ x: 0, y: 0, width: 500, height: 200_000 }, 0);
        const damage = history_flash_damage(flash, { x: 2, y: 10, width: 3, height: 2 });
        expect(damage.map((item) => item.cell)).toEqual([
            [2, 10], [2, 11], [3, 10], [3, 11], [4, 10], [4, 11],
        ]);
    });

    it('damages nothing when the flash is scrolled out of view', () => {
        const flash = begin_history_flash({ x: 0, y: 0, width: 2, height: 2 }, 0);
        expect(history_flash_damage(flash, { x: 40, y: 900, width: 5, height: 5 })).toEqual([]);
    });
});

describe('history_focus_request', () => {
    it('carries the host rows and the renderer-resolved columns together', () => {
        const built = history_focus_request(
            9,
            'redo',
            1,
            { displayRowStart: 4, displayRowEnd: 6, mappingGeneration: 2 },
            3,
            3,
        );
        expect(built).toEqual({
            sequence: 9,
            // The direction rides along so the warning for a hidden region can say
            // "redone" rather than guessing from a stack that may already have moved.
            direction: 'redo',
            sheetIndex: 1,
            displayRowStart: 4,
            displayRowEnd: 6,
            sourceColumnStart: 3,
            sourceColumnEnd: 3,
            mappingGeneration: 2,
        });
        expect(Object.isFrozen(built)).toBe(true);
    });
});
