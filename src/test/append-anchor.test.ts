import { describe, expect, it } from 'vitest';
import {
    APPEND_ANCHOR_HEADER_CLEARANCE_PX,
    APPEND_ANCHOR_SCROLLBAR_CLEARANCE_PX,
    append_anchor_key,
    compute_append_anchor,
    type AppendSlotRect,
} from '../webview/append-anchor';

const slot = (overrides: Partial<AppendSlotRect> = {}): AppendSlotRect => ({
    left: 0,
    top: 400,
    width: 36,
    height: 24,
    ...overrides,
});

describe('compute_append_anchor', () => {
    it('falls back to the corner when the root has no height', () => {
        expect(compute_append_anchor({ root_height: 0, slot: slot(), dock_open: false }))
            .toBe('corner');
        expect(compute_append_anchor({ root_height: -5, slot: slot(), dock_open: true }))
            .toBe('corner');
    });

    it('hides a closed dock when the grid reports no slot', () => {
        expect(compute_append_anchor({ root_height: 600, slot: undefined, dock_open: false }))
            .toBe('hidden');
    });

    it('keeps an open dock mounted in the corner when the slot is unmeasurable', () => {
        expect(compute_append_anchor({ root_height: 600, slot: undefined, dock_open: true }))
            .toBe('corner');
        expect(compute_append_anchor({
            root_height: 600,
            slot: slot({ height: 0 }),
            dock_open: true,
        })).toBe('corner');
    });

    it('reproduces the slot exactly when it is fully on screen', () => {
        const anchor = compute_append_anchor({
            root_height: 600,
            slot: slot({ left: 2, top: 401.4, width: 44.2, height: 23.6 }),
            dock_open: false,
        });
        expect(anchor).toEqual({ left: 2, top: 401, width: 44, height: 24, panel_lift: 0 });
    });

    it('enforces a minimum touchable size on degenerate rows', () => {
        const anchor = compute_append_anchor({
            root_height: 600,
            slot: slot({ width: 4, height: 3 }),
            dock_open: false,
        });
        expect(anchor).toMatchObject({ width: 16, height: 16 });
    });

    describe('closed-dock visibility window', () => {
        it('stays mounted while any pixel of the slot is inside the viewport', () => {
            // Slot top exactly one pixel above the bottom edge: partially
            // visible, so it renders and clips like a real row would.
            const anchor = compute_append_anchor({
                root_height: 600,
                slot: slot({ top: 599 }),
                dock_open: false,
            });
            expect(anchor).toMatchObject({ top: 599 });
        });

        it('hides once the slot top reaches the viewport bottom', () => {
            expect(compute_append_anchor({
                root_height: 600,
                slot: slot({ top: 600 }),
                dock_open: false,
            })).toBe('hidden');
            expect(compute_append_anchor({
                root_height: 600,
                slot: slot({ top: 1200 }),
                dock_open: false,
            })).toBe('hidden');
        });

        it('renders a slot emerging from under the header band', () => {
            const top = APPEND_ANCHOR_HEADER_CLEARANCE_PX - 10;
            const anchor = compute_append_anchor({
                root_height: 600,
                slot: slot({ top, height: 24 }),
                dock_open: false,
            });
            expect(anchor).toMatchObject({ top });
        });

        it('hides a slot fully behind the header band', () => {
            expect(compute_append_anchor({
                root_height: 600,
                slot: slot({ top: APPEND_ANCHOR_HEADER_CLEARANCE_PX - 24, height: 24 }),
                dock_open: false,
            })).toBe('hidden');
            expect(compute_append_anchor({
                root_height: 600,
                slot: slot({ top: -300 }),
                dock_open: false,
            })).toBe('hidden');
        });
    });

    describe('open-dock pinning', () => {
        it('leaves an on-screen slot where it is', () => {
            const anchor = compute_append_anchor({
                root_height: 600,
                slot: slot({ top: 300 }),
                dock_open: true,
            });
            expect(anchor).toMatchObject({ top: 300 });
        });

        it('pins a slot scrolled below the viewport to the bottom edge', () => {
            const anchor = compute_append_anchor({
                root_height: 600,
                slot: slot({ top: 900, height: 24 }),
                dock_open: true,
            });
            expect(anchor).toMatchObject({
                top: 600 - 24 - APPEND_ANCHOR_SCROLLBAR_CLEARANCE_PX,
            });
        });

        it('pins a slot scrolled above the header to the header clearance', () => {
            const anchor = compute_append_anchor({
                root_height: 600,
                slot: slot({ top: -200 }),
                dock_open: true,
            });
            expect(anchor).toMatchObject({ top: APPEND_ANCHOR_HEADER_CLEARANCE_PX });
        });

        it('falls back to the corner when the viewport cannot hold the pinned slot', () => {
            expect(compute_append_anchor({
                root_height: 60,
                slot: slot({ top: 20, height: 24 }),
                dock_open: true,
            })).toBe('corner');
        });
    });

    describe('panel bottom alignment', () => {
        it('aligns the panel bottom with the slot bottom when fully on screen', () => {
            const anchor = compute_append_anchor({
                root_height: 600,
                slot: slot({ top: 500, height: 24 }),
                dock_open: false,
            });
            expect(anchor).toMatchObject({ panel_lift: 0 });
        });

        it('lifts the panel by the clipped amount when the slot pokes past the viewport', () => {
            // Slot occupies 590..614 in a 600px root: 14px clipped, so the
            // panel bottom must sit 14px above the slot bottom — on the
            // viewport edge, never below it.
            const anchor = compute_append_anchor({
                root_height: 600,
                slot: slot({ top: 590, height: 24 }),
                dock_open: false,
            });
            expect(anchor).toMatchObject({ top: 590, panel_lift: 14 });
        });
    });
});

describe('append_anchor_key', () => {
    it('is stable for equal geometry and distinct otherwise', () => {
        const a = compute_append_anchor({ root_height: 600, slot: slot(), dock_open: false });
        const b = compute_append_anchor({ root_height: 600, slot: slot(), dock_open: false });
        const c = compute_append_anchor({
            root_height: 600,
            slot: slot({ top: 401 }),
            dock_open: false,
        });
        expect(append_anchor_key(a)).toBe(append_anchor_key(b));
        expect(append_anchor_key(a)).not.toBe(append_anchor_key(c));
        expect(append_anchor_key('hidden')).toBe('hidden');
        expect(append_anchor_key('corner')).toBe('corner');
    });
});
